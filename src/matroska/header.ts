import type { Element, Window } from "../ebml.js";
import * as E from "../ebml.js";
import { HEAD_BYTES, type Inflate, type Source, stopIfAborted } from "../io/source.js";
import { windowAt } from "../io/windows.js";
import type {
  Attachment,
  ContainerInfo,
  RefusalCode,
  TrackFlags,
  TrackTag,
} from "../vocabulary.js";
import {
  CLUSTER_PROBE_BYTES,
  headerNeed,
  hopTopLevel,
  pastSegment,
  readClusterTicks,
  readPastHead,
  type Segment,
  type SegmentPass,
} from "./chain.js";
import { type ContentEncoding, codecPrivateOf, encodingsIn } from "./encoding.js";

export interface TrackEntry {
  index: number;
  number: number;
  uid: string | null;
  typeCode: number;
  codecId: string;
  codecPrivate: Uint8Array | null;
  language: string | null;
  languageIetf: string | null;
  name: string | null;
  flags: TrackFlags;
  codecDelayNs: number;
  /** null when the track states ContentEncodings that do not parse. */
  encodings: ContentEncoding[] | null;
}

export interface CuePosition {
  clusterPos: number;
  relPos: number;
  ticks: number | null;
}

/** Each track's cue points, by TrackNumber. */
export type CueIndex = Map<number, CuePosition[]>;

/** A Segment whose head, Tracks and Tags are read. */
export interface OpenedSegment {
  source: Source;
  segment: Segment;
  head: Window;
  /** Where each top-level element starts, as the head and its SeekHeads state. */
  offsets: Map<number, number>;
  trackEntries: TrackEntry[];
  /** The tags each track states, by TrackUID. */
  trackTags: Map<string, TrackTag[]>;
}

export async function openSegment(
  source: Source,
  signal: AbortSignal | undefined,
  inflate: Inflate,
): Promise<OpenedSegment | RefusalCode> {
  stopIfAborted(signal);
  const fileSize = await source.size(signal);
  const head = await windowAt({ source, fileSize }, 0, HEAD_BYTES, signal);

  const ebml = E.readElement(head, 0);
  if (!readsAs(ebml, E.ID.root.EBML)) return "not-matroska";

  const segmentEl = E.readElement(head, ebml.next);
  if (typeof segmentEl === "string" || segmentEl.id !== E.ID.root.SEGMENT) {
    return "malformed";
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
    fetchElement(located, E.ID.segment.TRACKS),
    fetchedOptional(located, E.ID.segment.TAGS, noTags, parseTrackTags),
  ]);
  if (fetchedTracks === null) return "malformed";

  const parsed = parseTracks(fetchedTracks.window, fetchedTracks.element);
  const meant = async (entry: TrackEntry): Promise<TrackEntry> => {
    const codecPrivate = await codecPrivateOf(entry.codecPrivate, entry.encodings, inflate);
    return { ...entry, codecPrivate };
  };
  const trackEntries = await Promise.all(parsed.map(meant));
  return { source, segment, head, offsets, trackEntries, trackTags };
}

export function readInfo(
  opened: OpenedSegment,
  signal: AbortSignal | undefined,
): Promise<ContainerInfo> {
  const located = { ...opened, signal };
  const noInfo = defaultInfo();
  return fetchedOptional(located, E.ID.segment.INFO, noInfo, parseInfo);
}

export function readFirstClusterTicks(
  opened: OpenedSegment,
  signal: AbortSignal | undefined,
): Promise<number | null> {
  const located = { ...opened, signal };
  return optional<number | null>(null, () => firstClusterTicksIn(located));
}

export function readCues(
  opened: OpenedSegment,
  signal: AbortSignal | undefined,
): Promise<CueIndex> {
  const located = { ...opened, signal };
  const parseCuesIn = (window: Window, el: Element) => parseCues(window, el, opened.segment);
  const noCues: CueIndex = new Map();
  return fetchedOptional(located, E.ID.segment.CUES, noCues, parseCuesIn);
}

/** What each attached file states of itself, its bytes left where they are. */
export async function readAttachments(
  opened: OpenedSegment,
  signal: AbortSignal | undefined,
): Promise<Attachment[]> {
  const located = { ...opened, signal };
  const at = located.offsets.get(E.ID.segment.ATTACHMENTS);
  if (at === undefined) return [];
  const window = await probed(located, at, located.head.fileSize, located.head);
  const attachmentsEl = E.readElement(window, at);
  if (!readsAs(attachmentsEl, E.ID.segment.ATTACHMENTS)) return [];
  const attachments: Attachment[] = [];
  const visit: Visit = async (_at, fileEl, held) => {
    if (fileEl.id !== E.ID.attachment.FILE) return held;
    const file = await readAttachedFile(located, fileEl, held);
    if (file === null) return null;
    attachments.push(file.file);
    return file.window;
  };
  const last = await eachChildIn(located, attachmentsEl, window, visit);
  return last === null ? [] : attachments;
}

interface Located extends SegmentPass {
  offsets: Map<number, number>;
}

interface Placed {
  offsets: Map<number, number>;
  /** The first SeekHead that the head's SeekHeads name. */
  chained: number | null;
}

/**
 * Looks at one child and hands back the window the next child's head is read from.
 *
 * null fails the whole walk.
 */
type Visit = (at: number, field: Element, window: Window) => Promise<Window | null>;

const ELEMENT_PROBE_BYTES = 4096;

/** The most an attached file's name, type, description or UID may take; a larger one is skipped. */
const MAX_ATTACHED_FIELD_BYTES = 4096;

/** The most that is fetched for one header element, whatever size it states. */
const MAX_HEADER_ELEMENT_BYTES = 64 * 1024 ** 2;

/**
 * The runaway cap of an attachment walk.
 *
 * The list and the walk inside each file count apart, so the worst case is their product.
 */
const MAX_ATTACHMENT_CHILDREN = 4096;

const defaultInfo = (): ContainerInfo => ({
  title: null,
  muxingApp: null,
  writingApp: null,
  durationMs: null,
  timestampScale: E.DEFAULT_TIMESTAMP_SCALE,
});

const readsAs = (el: ReturnType<typeof E.readElement>, id: number): el is Element =>
  E.decoded(el) && el.id === id;

const fetchedOptional = <T>(
  located: Located,
  id: number,
  fallback: T,
  parse: (window: Window, element: Element) => T,
): Promise<T> =>
  optional(fallback, async () => {
    const fetched = await fetchElement(located, id);
    if (fetched === null) return fallback;
    return parse(fetched.window, fetched.element);
  });

function probed(located: Located, at: number, limit: number, held: Window): Promise<Window> {
  const need = headerNeed(at, limit);
  if (E.covers(held, at, need)) return Promise.resolve(held);
  const width = Math.min(ELEMENT_PROBE_BYTES, limit - at);
  return readPastHead(located, at, width, held);
}

function flagOf(window: Window, field: Element): boolean {
  return E.readUint(window, field) === 1;
}

function simpleTag(window: Window, { size, body }: Element): TrackTag {
  let name = "";
  let value = "";
  for (const part of E.children(window, body, size)) {
    if (part.id === E.ID.tag.NAME) {
      name = E.readUtf8(window, part);
    } else if (part.id === E.ID.tag.STRING) {
      value = E.readUtf8(window, part);
    }
  }
  return { name, value };
}

async function optional<T>(fallback: T, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!E.isGrammarError(error)) throw error;
    return fallback;
  }
}

async function firstClusterTicksIn(located: Located): Promise<number | null> {
  let at = located.offsets.get(E.ID.segment.CLUSTER);
  let held = located.head;
  if (at === undefined) {
    for await (const hop of hopTopLevel(located)) {
      if (hop.el.id === E.ID.segment.CLUSTER) {
        at = hop.at;
        held = hop.window;
        break;
      }
    }
  }
  if (at === undefined) return null;

  const window = await readPastHead(located, at, CLUSTER_PROBE_BYTES, held);
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
      if (el.id === E.ID.segment.CLUSTER && !offsets.has(el.id)) {
        offsets.set(el.id, pos);
      }
      break;
    }
    if (pastSegment(el, segment)) break;
    if (!offsets.has(el.id)) {
      offsets.set(el.id, pos);
    }
    if (el.id === E.ID.segment.SEEK_HEAD) seekHeads.push(el);
    if (el.id === E.ID.segment.CLUSTER) break;
    pos = el.next;
  }
  let chained: number | null = null;
  try {
    for (const seekHead of seekHeads) {
      const named = placeSeeks(head, seekHead, segment, offsets);
      chained ??= named[0] ?? null;
    }
  } catch (error) {
    if (!E.isGrammarError(error)) throw error;
  }
  return { offsets, chained };
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
    if (seek.id !== E.ID.seek.ENTRY) continue;
    let id = 0;
    let position = 0;
    for (const field of E.children(window, seek.body, seek.size)) {
      if (field.id === E.ID.seek.ID) {
        id = E.readUint(window, field);
      } else if (field.id === E.ID.seek.POSITION) {
        position = E.readUint(window, field);
      }
    }
    const at = segment.body + position;
    if (at >= window.fileSize) continue;
    if (id === E.ID.segment.SEEK_HEAD) {
      seekHeads.push(at);
    } else if (id !== E.ID.segment.CLUSTER && !offsets.has(id)) {
      offsets.set(id, at);
    }
  }
  return seekHeads;
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
    const fetched = await fetchAt(located, E.ID.segment.SEEK_HEAD, at);
    if (fetched === null) return;
    placeSeeks(fetched.window, fetched.element, located.segment, located.offsets);
  });
}

function parseCues(window: Window, cues: Element, segment: Segment): CueIndex {
  const byTrack: CueIndex = new Map();
  const { bytes } = window;
  // The child walk is unrolled by hand.
  // With a cue point per subtitle frame, an object per element is the cost.
  const startOf = (at: number, need: number) => {
    const start = at - window.at;
    if (start < 0 || start + need > bytes.length) throw new E.GrammarError();
    return start;
  };
  const cursor = { id: 0, body: 0, next: 0 };
  const readElementHeader = (at: number, end: number) => {
    const idStart = startOf(at, 1);
    const idLength = E.vintLength(bytes[idStart] as number);
    if (idLength > E.MAX_VINT_BYTES) throw new E.GrammarError();
    startOf(at, idLength);
    cursor.id = E.vintValue(bytes, idStart, idLength, "id");
    const sizeAt = at + idLength;
    const sizeStart = startOf(sizeAt, 1);
    const sizeLength = E.vintLength(bytes[sizeStart] as number);
    if (sizeLength > E.MAX_VINT_BYTES) throw new E.GrammarError();
    startOf(sizeAt, sizeLength);
    cursor.body = sizeAt + sizeLength;
    cursor.next = cursor.body + E.vintValue(bytes, sizeStart, sizeLength, "size");
    if (cursor.next > end) throw new E.GrammarError();
  };
  const cursorUint = () => {
    const size = cursor.next - cursor.body;
    const start = startOf(cursor.body, size);
    return E.uintValue(bytes, start, size);
  };
  const pointTicks = (body: number, next: number) => {
    let fieldAt = body;
    while (fieldAt < next) {
      readElementHeader(fieldAt, next);
      if (cursor.id === E.ID.cue.TIME) return cursorUint();
      fieldAt = cursor.next;
    }
    return null;
  };
  const end = cues.body + cues.size;
  let at = cues.body;
  while (at < end) {
    readElementHeader(at, end);
    const pointId = cursor.id;
    const pointBody = cursor.body;
    const pointNext = cursor.next;
    if (pointId === E.ID.cue.POINT) {
      const ticks = pointTicks(pointBody, pointNext);
      let fieldAt = pointBody;
      while (fieldAt < pointNext) {
        readElementHeader(fieldAt, pointNext);
        const fieldId = cursor.id;
        const fieldBody = cursor.body;
        const fieldNext = cursor.next;
        if (fieldId === E.ID.cue.TRACK_POSITIONS) {
          let trackNumber = 0;
          let clusterPos = 0;
          let relPos = 0;
          let itemAt = fieldBody;
          while (itemAt < fieldNext) {
            readElementHeader(itemAt, fieldNext);
            const itemId = cursor.id;
            const value = cursorUint();
            if (itemId === E.ID.cue.TRACK) {
              trackNumber = value;
            } else if (itemId === E.ID.cue.CLUSTER_POSITION) {
              clusterPos = value;
            } else if (itemId === E.ID.cue.RELATIVE_POSITION) {
              relPos = value;
            }
            itemAt = cursor.next;
          }
          const position: CuePosition = { clusterPos: segment.body + clusterPos, relPos, ticks };
          const list = byTrack.get(trackNumber);
          if (list === undefined) byTrack.set(trackNumber, [position]);
          else list.push(position);
        }
        fieldAt = fieldNext;
      }
    }
    at = pointNext;
  }
  return byTrack;
}

async function fetchElement(
  located: Located,
  id: number,
): Promise<{ window: Window; element: Element } | null> {
  const at = located.offsets.get(id);
  if (at === undefined) return null;
  return fetchAt(located, id, at);
}

async function fetchAt(
  located: Located,
  id: number,
  at: number,
): Promise<{ window: Window; element: Element } | null> {
  const probe = await probed(located, at, located.head.fileSize, located.head);
  const header = E.readElement(probe, at);
  if (!readsAs(header, id)) return null;
  if (header.next - at > MAX_HEADER_ELEMENT_BYTES) return null;
  const window = await readPastHead(located, at, header.next - at, probe);
  return { window, element: header };
}

function parseTracks(window: Window, tracks: Element): TrackEntry[] {
  const entries: TrackEntry[] = [];
  let index = 0;
  for (const entryEl of E.children(window, tracks.body, tracks.size)) {
    if (entryEl.id !== E.ID.track.ENTRY) continue;
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
      if (id === E.ID.track.NUMBER) {
        entry.number = E.readUint(window, field);
      } else if (id === E.ID.track.UID) {
        entry.uid = E.readUid(window, field);
      } else if (id === E.ID.track.TYPE) {
        entry.typeCode = E.readUint(window, field);
      } else if (id === E.ID.track.CODEC_ID) {
        entry.codecId = E.readAscii(window, field);
      } else if (id === E.ID.track.CODEC_PRIVATE) {
        entry.codecPrivate = E.readBytes(window, field.body, field.size).slice();
      } else if (id === E.ID.track.CODEC_DELAY) {
        entry.codecDelayNs = E.readUint(window, field);
      } else if (id === E.ID.track.LANGUAGE) {
        entry.language = E.readAscii(window, field);
      } else if (id === E.ID.track.LANGUAGE_IETF) {
        entry.languageIetf = E.readAscii(window, field);
      } else if (id === E.ID.track.NAME) {
        entry.name = E.readUtf8(window, field);
      } else if (id === E.ID.track.FLAG_FORCED) {
        entry.flags.forced = flagOf(window, field);
      } else if (id === E.ID.track.FLAG_DEFAULT) {
        entry.flags.default = flagOf(window, field);
      } else if (id === E.ID.track.FLAG_ENABLED) {
        entry.flags.enabled = flagOf(window, field);
      } else if (id === E.ID.track.FLAG_HEARING_IMPAIRED) {
        entry.flags.hearingImpaired = flagOf(window, field);
      } else if (id === E.ID.track.FLAG_VISUAL_IMPAIRED) {
        entry.flags.visualImpaired = flagOf(window, field);
      } else if (id === E.ID.track.FLAG_TEXT_DESCRIPTIONS) {
        entry.flags.textDescriptions = flagOf(window, field);
      } else if (id === E.ID.track.FLAG_ORIGINAL) {
        entry.flags.original = flagOf(window, field);
      } else if (id === E.ID.track.FLAG_COMMENTARY) {
        entry.flags.commentary = flagOf(window, field);
      } else if (id === E.ID.track.CONTENT_ENCODINGS) {
        entry.encodings = encodingsIn(window, field);
      }
    }
    entries.push(entry);
  }
  return entries;
}

function parseTimestampScale(window: Window, info: Element): number {
  for (const field of E.children(window, info.body, info.size)) {
    if (field.id !== E.ID.info.TIMESTAMP_SCALE) continue;
    const scale = E.readUint(window, field);
    if (scale > 0) return scale;
  }
  return E.DEFAULT_TIMESTAMP_SCALE;
}

/**
 * Null past the cap or past the parent.
 *
 * A child that does not read ends the walk, which hands back the last window.
 */
async function eachChildIn(
  located: Located,
  parent: Element,
  held: Window,
  visit: Visit,
): Promise<Window | null> {
  let window = held;
  let pos = parent.body;
  let children = 0;
  while (pos < parent.next) {
    children += 1;
    if (children > MAX_ATTACHMENT_CHILDREN) return null;
    window = await probed(located, pos, parent.next, window);
    const field = E.readElement(window, pos);
    if (!E.decoded(field)) return window;
    if (!E.fits(field, parent.next)) return null;
    const nextWindow = await visit(pos, field, window);
    if (nextWindow === null) return null;
    window = nextWindow;
    pos = field.next;
  }
  return window;
}

async function readAttachedFile(
  located: Located,
  fileEl: Element,
  held: Window,
): Promise<{ file: Attachment; window: Window } | null> {
  const out: Attachment = {
    fileName: null,
    mimeType: null,
    description: null,
    at: null,
    size: 0,
    uid: null,
  };
  const visit: Visit = async (at, field, held) => {
    if (field.id === E.ID.attachment.FILE_DATA) {
      out.at = field.body;
      out.size = field.size;
      return held;
    }
    if (field.next - at > MAX_ATTACHED_FIELD_BYTES) return held;
    const window = await readPastHead(located, at, field.next - at, held);
    if (field.id === E.ID.attachment.FILE_NAME) {
      out.fileName = E.readUtf8(window, field);
    } else if (field.id === E.ID.attachment.FILE_MIME) {
      out.mimeType = E.readAscii(window, field);
    } else if (field.id === E.ID.attachment.FILE_DESCRIPTION) {
      out.description = E.readUtf8(window, field);
    } else if (field.id === E.ID.attachment.FILE_UID) {
      out.uid = E.readUid(window, field);
    }
    return window;
  };
  const last = await eachChildIn(located, fileEl, held, visit);
  return last === null ? null : { file: out, window: last };
}

function parseInfo(window: Window, info: Element): ContainerInfo {
  const scale = parseTimestampScale(window, info);
  const out: ContainerInfo = { ...defaultInfo(), timestampScale: scale };
  for (const field of E.children(window, info.body, info.size)) {
    const { id } = field;
    if (id === E.ID.info.TITLE) {
      out.title = E.readUtf8(window, field);
    } else if (id === E.ID.info.MUXING_APP) {
      out.muxingApp = E.readUtf8(window, field);
    } else if (id === E.ID.info.WRITING_APP) {
      out.writingApp = E.readUtf8(window, field);
    } else if (id === E.ID.info.DURATION) {
      const ticks = E.readFloat(window, field);
      if (ticks !== null) {
        out.durationMs = (ticks * scale) / 1_000_000;
      }
    }
  }
  return out;
}

function parseTrackTags(window: Window, tags: Element): Map<string, TrackTag[]> {
  const byUid = new Map<string, TrackTag[]>();
  for (const tag of E.children(window, tags.body, tags.size)) {
    if (tag.id !== E.ID.tag.ENTRY) continue;
    let uid: string | null = null;
    const simpleTags: TrackTag[] = [];
    for (const field of E.children(window, tag.body, tag.size)) {
      if (field.id === E.ID.tag.TARGETS) {
        for (const target of E.children(window, field.body, field.size)) {
          if (target.id === E.ID.tag.TRACK_UID) {
            uid = E.readUid(window, target);
          }
        }
      } else if (field.id === E.ID.tag.SIMPLE) {
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
