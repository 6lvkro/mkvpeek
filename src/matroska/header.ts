import type { Element, Window } from "../ebml.js";
import * as E from "../ebml.js";
import { stopIfAborted } from "../io/abort.js";
import { HEAD_BYTES, type Inflate, type Source } from "../io/source.js";
import { heldOrRead, windowAt } from "../io/windows.js";
import {
  type ContainerInfo,
  RefusalError,
  type Track,
  type TrackTag,
  type TrackType,
} from "../vocabulary.js";
import {
  CLUSTER_PROBE_BYTES,
  fetchAt,
  fetchElement,
  fetchedOptional,
  hopTopLevel,
  type Located,
  optional,
  pastSegment,
  readClusterTicks,
  readsAs,
  type Segment,
} from "./chain.js";
import {
  type ContentEncoding,
  codecPrivateOf,
  encodingsIn,
  FRAMES_SCOPE,
  type Undo,
  undoFor,
} from "./encoding.js";
import { ID } from "./ids.js";

/** A Segment whose head, Tracks and Tags are read. */
export interface OpenedSegment {
  source: Source;
  segment: Segment;
  head: Window;
  /** Where each top-level element starts, as the head and its SeekHeads state. */
  offsets: Map<number, number>;
  openedTracks: OpenedTrack[];
}

export interface OpenedTrack {
  track: Track;
  /** Null where no encoding is applied, and false where this reader cannot undo it. */
  undo: Undo | null | false;
}

export const msOfTicks = (ticks: number, nsPerTick: number): number =>
  (ticks * nsPerTick) / NS_PER_MS;

export async function openSegment(
  source: Source,
  signal: AbortSignal | undefined,
  inflate: Inflate,
): Promise<OpenedSegment> {
  stopIfAborted(signal);
  const fileSize = await source.size(signal);
  const head = await windowAt({ source, fileSize }, 0, HEAD_BYTES, signal);

  const ebml = E.readElement(head, 0);
  if (!readsAs(ebml, ID.root.EBML)) throw new RefusalError("not-matroska");

  const segmentEl = E.readElement(head, ebml.next);
  if (typeof segmentEl === "string" || segmentEl.id !== ID.root.SEGMENT) {
    throw new RefusalError("malformed");
  }

  const segment: Segment = {
    body: segmentEl.body,
    end: "open" in segmentEl ? fileSize : segmentEl.next,
  };
  const { offsets, chained } = locateTopLevel(head, segment);
  const located: Located = { source, segment, head, signal, offsets };
  if (chained !== null) await placeChained(located, chained);
  const noTags = new Map<string, TrackTag[]>();
  const [fetchedTracks, trackTags] = await Promise.all([
    fetchElement(located, ID.segment.TRACKS),
    fetchedOptional(located, ID.segment.TAGS, noTags, parseTrackTags),
  ]);
  if (fetchedTracks === null) throw new RefusalError("malformed");

  const parsed = parseTracks(fetchedTracks.window, fetchedTracks.element);
  const meant = async ({ typeCode, encodings, ...stated }: TrackEntry): Promise<OpenedTrack> => {
    const codecPrivate = await codecPrivateOf(stated.codecPrivate, encodings, inflate);
    const type = TYPE_BY_CODE.get(typeCode) ?? "unknown";
    const tags = stated.uid === null ? [] : (trackTags.get(stated.uid) ?? []);
    // Written back where it was spread, so the keys keep the order Track states them in.
    const track = { type, ...stated, codecPrivate, tags };
    return { track, undo: undoFor(encodings, FRAMES_SCOPE, inflate) };
  };
  const openedTracks = await Promise.all(parsed.map(meant));
  return { source, segment, head, offsets, openedTracks };
}

export function readInfo(
  opened: OpenedSegment,
  signal: AbortSignal | undefined,
): Promise<ContainerInfo> {
  const located = { ...opened, signal };
  const noInfo = defaultInfo();
  return fetchedOptional(located, ID.segment.INFO, noInfo, parseInfo);
}

export function readFirstClusterTicks(
  opened: OpenedSegment,
  signal: AbortSignal | undefined,
): Promise<number | null> {
  const located = { ...opened, signal };
  return optional<number | null>(null, () => firstClusterTicksIn(located));
}

/** Its CodecPrivate is as stored, before the encodings are undone. */
interface TrackEntry extends Omit<Track, "type" | "tags"> {
  typeCode: number;
  /** null when the track states ContentEncodings that do not parse. */
  encodings: ContentEncoding[] | null;
}

interface Placed {
  offsets: Map<number, number>;
  /** The first SeekHead that the head's SeekHeads name. */
  chained: number | null;
}

const DEFAULT_TIMESTAMP_SCALE = 1_000_000;

const NS_PER_MS = 1_000_000;

const TYPE_BY_CODE: ReadonlyMap<number, TrackType> = new Map([
  [1, "video"],
  [2, "audio"],
  [3, "complex"],
  [16, "logo"],
  [17, "subtitle"],
  [18, "buttons"],
  [32, "control"],
  [33, "metadata"],
]);

const defaultInfo = (): ContainerInfo => ({
  title: null,
  muxingApp: null,
  writingApp: null,
  durationMs: null,
  timestampScale: DEFAULT_TIMESTAMP_SCALE,
});

async function firstClusterTicksIn(located: Located): Promise<number | null> {
  let at = located.offsets.get(ID.segment.CLUSTER);
  let held = located.head;
  if (at === undefined) {
    for await (const hop of hopTopLevel(located)) {
      if (hop.el.id === ID.segment.CLUSTER) {
        at = hop.at;
        held = hop.window;
        break;
      }
    }
  }
  if (at === undefined) return null;

  const window = await heldOrRead(located.source, held, at, CLUSTER_PROBE_BYTES, located.signal);
  const cluster = E.readElement(window, at);
  if (typeof cluster === "string") return null;

  return readClusterTicks(window, cluster);
}

function locateTopLevel(head: Window, segment: Segment): Placed {
  const offsets = new Map<number, number>();
  let pos = segment.body;
  const seekHeads: Element[] = [];
  while (pos < segment.end) {
    const el = E.readElement(head, pos);
    if (typeof el === "string") break;
    if ("open" in el) {
      if (el.id === ID.segment.CLUSTER && !offsets.has(el.id)) {
        offsets.set(el.id, pos);
      }
      break;
    }
    if (pastSegment(el, segment)) break;
    if (!offsets.has(el.id)) {
      offsets.set(el.id, pos);
    }
    if (el.id === ID.segment.SEEK_HEAD) seekHeads.push(el);
    if (el.id === ID.segment.CLUSTER) break;
    pos = el.next;
  }
  let chained: number | null = null;
  try {
    for (const seekHead of seekHeads) {
      const named = placeSeeks(head, seekHead, segment, offsets);
      chained ??= named[0] ?? null;
    }
  } catch (error) {
    E.throwUnlessGrammar(error);
  }
  return { offsets, chained };
}

/**
 * Places what a second SeekHead names.
 *
 * RFC 9559 §5.1.1 allows no third, so a SeekHead it names is not followed.
 *
 * @see {@link https://www.rfc-editor.org/info/rfc9559/#name-seekhead-element}
 */
async function placeChained(located: Located, at: number): Promise<void> {
  await optional<void>(undefined, async () => {
    const fetched = await fetchAt(located, ID.segment.SEEK_HEAD, at);
    if (fetched === null) return;
    placeSeeks(fetched.window, fetched.element, located.segment, located.offsets);
  });
}

/** Places what a SeekHead names that nothing placed yet, and answers the SeekHeads it names. */
function placeSeeks(
  window: Window,
  seekHead: Element,
  segment: Segment,
  offsets: Map<number, number>,
): number[] {
  const seekHeads: number[] = [];
  for (const seek of E.children(window, seekHead.body, seekHead.size)) {
    if (seek.id !== ID.seek.ENTRY) continue;
    let id = 0;
    let position = 0;
    for (const field of E.children(window, seek.body, seek.size)) {
      if (field.id === ID.seek.ID) {
        id = E.readUint(window, field);
      } else if (field.id === ID.seek.POSITION) {
        position = E.readUint(window, field);
      }
    }
    const at = segment.body + position;
    if (at >= window.fileSize) continue;
    if (id === ID.segment.SEEK_HEAD) {
      seekHeads.push(at);
    } else if (id !== ID.segment.CLUSTER && !offsets.has(id)) {
      offsets.set(id, at);
    }
  }
  return seekHeads;
}

function parseTracks(window: Window, tracks: Element): TrackEntry[] {
  const entries: TrackEntry[] = [];
  let index = 0;
  for (const entryEl of E.children(window, tracks.body, tracks.size)) {
    if (entryEl.id !== ID.track.ENTRY) continue;
    const entry: TrackEntry = {
      index: index++,
      number: -1,
      uid: null,
      typeCode: -1,
      codecId: "",
      codecPrivate: null,
      language: null,
      languageIetf: null,
      name: null,
      flags: {
        enabled: true,
        default: true,
        forced: false,
        hearingImpaired: null,
        visualImpaired: null,
        textDescriptions: null,
        original: null,
        commentary: null,
      },
      codecDelayNs: 0,
      encodings: [],
    };
    for (const field of E.children(window, entryEl.body, entryEl.size)) {
      const { id } = field;
      if (id === ID.track.NUMBER) {
        entry.number = E.readUint(window, field);
      } else if (id === ID.track.UID) {
        entry.uid = E.readUid(window, field);
      } else if (id === ID.track.TYPE) {
        entry.typeCode = E.readUint(window, field);
      } else if (id === ID.track.CODEC_ID) {
        entry.codecId = E.readAscii(window, field);
      } else if (id === ID.track.CODEC_PRIVATE) {
        entry.codecPrivate = E.readBytes(window, field.body, field.size).slice();
      } else if (id === ID.track.CODEC_DELAY) {
        entry.codecDelayNs = E.readUint(window, field);
      } else if (id === ID.track.LANGUAGE) {
        entry.language = E.readAscii(window, field);
      } else if (id === ID.track.LANGUAGE_IETF) {
        entry.languageIetf = E.readAscii(window, field);
      } else if (id === ID.track.NAME) {
        entry.name = E.readUtf8(window, field);
      } else if (id === ID.track.FLAG_FORCED) {
        entry.flags.forced = flagOf(window, field);
      } else if (id === ID.track.FLAG_DEFAULT) {
        entry.flags.default = flagOf(window, field);
      } else if (id === ID.track.FLAG_ENABLED) {
        entry.flags.enabled = flagOf(window, field);
      } else if (id === ID.track.FLAG_HEARING_IMPAIRED) {
        entry.flags.hearingImpaired = flagOf(window, field);
      } else if (id === ID.track.FLAG_VISUAL_IMPAIRED) {
        entry.flags.visualImpaired = flagOf(window, field);
      } else if (id === ID.track.FLAG_TEXT_DESCRIPTIONS) {
        entry.flags.textDescriptions = flagOf(window, field);
      } else if (id === ID.track.FLAG_ORIGINAL) {
        entry.flags.original = flagOf(window, field);
      } else if (id === ID.track.FLAG_COMMENTARY) {
        entry.flags.commentary = flagOf(window, field);
      } else if (id === ID.track.CONTENT_ENCODINGS) {
        entry.encodings = encodingsIn(window, field);
      }
    }
    entries.push(entry);
  }
  return entries;
}

function flagOf(window: Window, field: Element): boolean {
  return E.readUint(window, field) === 1;
}

function parseInfo(window: Window, info: Element): ContainerInfo {
  const scale = parseTimestampScale(window, info);
  const out: ContainerInfo = { ...defaultInfo(), timestampScale: scale };
  for (const field of E.children(window, info.body, info.size)) {
    const { id } = field;
    if (id === ID.info.TITLE) {
      out.title = E.readUtf8(window, field);
    } else if (id === ID.info.MUXING_APP) {
      out.muxingApp = E.readUtf8(window, field);
    } else if (id === ID.info.WRITING_APP) {
      out.writingApp = E.readUtf8(window, field);
    } else if (id === ID.info.DURATION) {
      const ticks = E.readFloat(window, field);
      if (ticks !== null) {
        out.durationMs = msOfTicks(ticks, scale);
      }
    }
  }
  return out;
}

function parseTimestampScale(window: Window, info: Element): number {
  for (const field of E.children(window, info.body, info.size)) {
    if (field.id !== ID.info.TIMESTAMP_SCALE) continue;
    const scale = E.readUint(window, field);
    if (scale > 0) return scale;
  }
  return DEFAULT_TIMESTAMP_SCALE;
}

function parseTrackTags(window: Window, tags: Element): Map<string, TrackTag[]> {
  const byUid = new Map<string, TrackTag[]>();
  for (const tag of E.children(window, tags.body, tags.size)) {
    if (tag.id !== ID.tag.ENTRY) continue;
    let uid: string | null = null;
    const simpleTags: TrackTag[] = [];
    for (const field of E.children(window, tag.body, tag.size)) {
      if (field.id === ID.tag.TARGETS) {
        for (const target of E.children(window, field.body, field.size)) {
          if (target.id === ID.tag.TRACK_UID) {
            uid = E.readUid(window, target);
          }
        }
      } else if (field.id === ID.tag.SIMPLE) {
        simpleTags.push(simpleTag(window, field));
      }
    }
    if (uid === null || simpleTags.length === 0) continue;
    const bag = byUid.get(uid);
    if (bag === undefined) {
      byUid.set(uid, simpleTags);
    } else {
      for (const each of simpleTags) bag.push(each);
    }
  }
  return byUid;
}

function simpleTag(window: Window, { size, body }: Element): TrackTag {
  let name = "";
  let value = "";
  for (const part of E.children(window, body, size)) {
    if (part.id === ID.tag.NAME) {
      name = E.readUtf8(window, part);
    } else if (part.id === ID.tag.STRING) {
      value = E.readUtf8(window, part);
    }
  }
  return { name, value };
}
