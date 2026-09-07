import type { Element, Window } from "../ebml.js";
import * as E from "../ebml.js";
import { gathered } from "../io/lanes.js";
import { HEAD_BYTES, type Source } from "../io/source.js";
import { windowAt } from "../io/windows.js";
import type {
  Attachment,
  ContainerInfo,
  RefusalCode,
  TrackFlags,
  TrackTag,
  Wants,
} from "../vocabulary.js";
import {
  CLUSTER_PROBE_BYTES,
  headerNeed,
  hopTopLevel,
  pastSegment,
  readClusterTime,
  readPastHead,
  type Segment,
  type SegmentPass,
} from "./chain.js";

export interface TrackEntry {
  streamIndex: number;
  number: number;
  uid: string | null;
  codecId: string;
  codecPrivate: string;
  codecDelayNs: number;
  type: number;
  language: string | null;
  languageIetf: string | null;
  name: string | null;
  flags: TrackFlags;
  encoded: boolean;
}

export interface CuePosition {
  clusterPos: number;
  relPos: number;
}

/** @see {@linkcode readContainer|readContainer(source, "tracks")} */
export interface TracksHeader {
  segment: Segment;
  trackEntries: TrackEntry[];
  fileSize: number;
  trackTags: Map<string, TrackTag[]>;
  info: ContainerInfo;
  attachments: Attachment[];
}

/** @see {@linkcode readContainer|readContainer(source, "timed")} */
export interface TimedHeader extends TracksHeader {
  head: Window;
  firstClusterTicks: number | null;
}

/** @see {@linkcode readContainer|readContainer(source, "indexed")} */
export interface IndexedHeader extends TimedHeader {
  cues: Map<number, CuePosition[]>;
}

interface ContainerReadOptions extends Wants {
  concurrency?: number | undefined;
  signal?: AbortSignal | undefined;
}

export async function readContainer(
  source: Source,
  depth: "tracks",
  options: ContainerReadOptions,
): Promise<TracksHeader | RefusalCode>;
export async function readContainer(
  source: Source,
  depth: "timed",
  options: ContainerReadOptions & { concurrency: number },
): Promise<TimedHeader | RefusalCode>;
export async function readContainer(
  source: Source,
  depth: "indexed",
  options: ContainerReadOptions & { concurrency: number },
): Promise<IndexedHeader | RefusalCode>;
export async function readContainer(
  source: Source,
  depth: "tracks" | "timed" | "indexed",
  { concurrency = 1, signal: stop, ...wants }: ContainerReadOptions,
): Promise<TracksHeader | TimedHeader | IndexedHeader | RefusalCode> {
  const opened = await openContainer(source, stop);
  if (typeof opened === "string") return opened;
  const { segment } = opened;
  const noTags = new Map<string, TrackTag[]>();
  const noCues = new Map<number, CuePosition[]>();
  const noInfo = emptyInfo();
  const noAttachments: Attachment[] = [];
  const parseCuesIn = (w: Window, el: Element) => parseCues(w, el, segment);
  // The timed depth fetches Info for its scale even when nobody asked for delivery.
  const wantsInfo = wants.info || depth !== "tracks";

  const fetchTrackTags = () => fetchedOptional(opened, E.ID.segment.TAGS, noTags, parseTrackTags);
  const fetchInfo = wantsInfo
    ? () => fetchedOptional(opened, E.ID.segment.INFO, noInfo, parseInfo)
    : () => Promise.resolve(noInfo);
  const fetchAttachments = wants.attachments
    ? () => readAttachments(opened)
    : () => Promise.resolve(noAttachments);
  const fetchTimedFields =
    depth !== "tracks" ? () => readTimedFields(opened) : () => Promise.resolve(null);
  const fetchCues =
    depth === "indexed"
      ? () => fetchedOptional(opened, E.ID.segment.CUES, noCues, parseCuesIn)
      : () => Promise.resolve(null);
  const fetches = [
    fetchTrackTags,
    fetchInfo,
    fetchAttachments,
    fetchTimedFields,
    fetchCues,
  ] as const;
  const [trackTags, info, attachments, timed, cues] = await gathered(fetches, concurrency, stop);

  return {
    ...opened.headerSoFar,
    trackTags,
    info,
    attachments,
    ...(timed === null ? {} : { head: opened.head, ...timed }),
    ...(cues === null ? {} : { cues }),
  };
}

/** The pass that learned where the top-level elements are. */
interface Located extends SegmentPass {
  offsets: Map<number, number>;
}

interface Opened extends Located {
  headerSoFar: Omit<TracksHeader, "trackTags" | "info" | "attachments">;
}

/**
 * Looks at one child and hands back the window the next child's head is read from.
 *
 * null fails the whole walk.
 */
type Visit = (at: number, field: Element, window: Window) => Promise<Window | null>;

const ELEMENT_PROBE_BYTES = 4096;

/** The most that is fetched for one header element, whatever size it states. */
const MAX_HEADER_ELEMENT_BYTES = 64 * 1024 ** 2;

/**
 * The runaway cap of the attachment walk.
 *
 * The list and the walk inside each file count separately, so the worst case is their product.
 */
const MAX_ATTACHMENT_CHILDREN = 4096;

const emptyInfo = (): ContainerInfo => ({
  title: null,
  muxingApp: null,
  writingApp: null,
  durationMs: null,
  timestampScale: E.DEFAULT_TIMESTAMP_SCALE,
});

const readsAs = (el: ReturnType<typeof E.readElement>, id: number): el is Element =>
  E.decoded(el) && el.id === id;

const nulTrimmed = (padded: string): string => padded.replace(/\0+$/, "");

/** Fetches and parses one optional top-level element, or folds to the absent answer. */
const fetchedOptional = <T>(
  opened: Located,
  id: number,
  fallback: T,
  parse: (window: Window, element: Element) => T | null,
): Promise<T> =>
  optional(fallback, async (fall) => {
    const el = await fetchElement(opened, id);
    if (el === null) return fall;
    return parse(el.window, el.element) ?? fall;
  });

/**
 * The probe of one element.
 *
 * If the head is inside `held` it is used as is;
 * otherwise `ELEMENT_PROBE_BYTES` are bought within the limit.
 */
function probed(opened: Located, at: number, limit: number, held: Window): Promise<Window> {
  const need = headerNeed(at, limit);
  if (E.covers(held, at, need)) return Promise.resolve(held);
  const width = Math.min(ELEMENT_PROBE_BYTES, limit - at);
  return readPastHead(opened, at, width, held);
}

function flagOf(window: Window, field: Element): boolean | null {
  const value = E.readUint(window, field);
  return value === null ? null : value === 1;
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
  return { name: nulTrimmed(name), value: nulTrimmed(value) };
}

async function openContainer(
  source: Source,
  signal: AbortSignal | undefined,
): Promise<Opened | RefusalCode> {
  const fileSize = await source.size();
  // A short answer throws here and reaches the fold.
  const head = await windowAt({ source, fileSize }, 0, HEAD_BYTES);

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
  const located = locateTopLevel(head, segment);
  const pass: Located = { source, segment, head, signal, offsets: located };
  const tracksEl = await fetchElement(pass, E.ID.segment.TRACKS);
  if (tracksEl === null) return "malformed";

  const tracks = parseTracks(tracksEl.window, tracksEl.element);
  if (typeof tracks === "string") return tracks;

  return { ...pass, headerSoFar: { segment, trackEntries: tracks, fileSize } };
}

async function readTimedFields(opened: Located): Promise<Pick<TimedHeader, "firstClusterTicks">> {
  const firstClusterTicks = await optional(null as number | null, () =>
    readFirstClusterTime(opened),
  );
  return { firstClusterTicks };
}

async function optional<T>(fallback: T, read: (fallback: T) => Promise<T>): Promise<T> {
  try {
    return await read(fallback);
  } catch (error) {
    if (!E.isGrammarError(error)) throw error;
    return fallback;
  }
}

async function readFirstClusterTime(opened: Located): Promise<number | null> {
  let at = opened.offsets.get(E.ID.segment.CLUSTER);
  let held = opened.head;
  if (at === undefined) {
    for await (const hop of hopTopLevel(opened)) {
      if (hop.el.id === E.ID.segment.CLUSTER) {
        at = hop.at;
        held = hop.window;
        break;
      }
    }
  }
  if (at === undefined) return null;

  const window = await readPastHead(opened, at, CLUSTER_PROBE_BYTES, held);
  const cluster = E.readElement(window, at);
  if (typeof cluster === "string" || cluster.id !== E.ID.segment.CLUSTER) return null;

  return readClusterTime(window, cluster);
}

function locateTopLevel(head: Window, segment: Segment): Map<number, number> {
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
  try {
    for (const seekHead of seekHeads) {
      for (const seek of E.children(head, seekHead.body, seekHead.size)) {
        if (seek.id !== E.ID.seek.ENTRY) continue;
        let id: number | null = null;
        let position: number | null = null;
        for (const field of E.children(head, seek.body, seek.size)) {
          if (field.id === E.ID.seek.ID) {
            id = E.readUint(head, field);
          } else if (field.id === E.ID.seek.POSITION) {
            position = E.readUint(head, field);
          }
        }
        if (id !== null && position !== null && !offsets.has(id)) {
          offsets.set(id, segment.body + position);
        }
      }
    }
  } catch (error) {
    if (!E.isGrammarError(error)) throw error;
  }
  return offsets;
}

function parseCues(
  window: Window,
  cues: Element,
  segment: Segment,
): Map<number, CuePosition[]> | null {
  const byTrack = new Map<number, CuePosition[]>();
  const { bytes } = window;
  // The child walk is unrolled by hand,
  // because with a cue point per subtitle frame an object per element is the cost.
  const startOf = (at: number, need: number) => {
    const start = at - window.at;
    if (start < 0 || start + need > bytes.length) throw new E.GrammarError();
    return start;
  };
  const cursor = { id: 0, body: 0, next: 0 };
  const readElementHead = (at: number, end: number) => {
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
    if (E.vintAllOnes(bytes, sizeStart, sizeLength)) throw new E.GrammarError();
    cursor.body = sizeAt + sizeLength;
    cursor.next = cursor.body + E.vintValue(bytes, sizeStart, sizeLength, "size");
    if (cursor.next > end) throw new E.GrammarError();
  };
  const end = cues.body + cues.size;
  let at = cues.body;
  while (at < end) {
    readElementHead(at, end);
    const pointId = cursor.id;
    const pointBody = cursor.body;
    const pointNext = cursor.next;
    if (pointId === E.ID.cue.POINT) {
      let fieldAt = pointBody;
      while (fieldAt < pointNext) {
        readElementHead(fieldAt, pointNext);
        const fieldId = cursor.id;
        const fieldBody = cursor.body;
        const fieldNext = cursor.next;
        if (fieldId === E.ID.cue.TRACK_POSITIONS) {
          let track: number | null = null;
          let clusterPos: number | null = null;
          let relPos: number | null = 0;
          let itemAt = fieldBody;
          while (itemAt < fieldNext) {
            readElementHead(itemAt, fieldNext);
            const itemId = cursor.id;
            const size = cursor.next - cursor.body;
            const start = startOf(cursor.body, size);
            const value = E.uintFits(size) ? E.uintAt(bytes, start, size) : null;
            if (itemId === E.ID.cue.TRACK) {
              track = value;
            } else if (itemId === E.ID.cue.CLUSTER_POSITION) {
              clusterPos = value;
            } else if (itemId === E.ID.cue.RELATIVE_POSITION) {
              relPos = value;
            }
            itemAt = cursor.next;
          }
          if (track === null || clusterPos === null || relPos === null) return null;
          const entry: CuePosition = { clusterPos: segment.body + clusterPos, relPos };
          const list = byTrack.get(track);
          if (list === undefined) byTrack.set(track, [entry]);
          else list.push(entry);
        }
        fieldAt = fieldNext;
      }
    }
    at = pointNext;
  }
  return byTrack;
}

async function fetchElement(
  opened: Located,
  id: number,
): Promise<{ window: Window; element: Element } | null> {
  const at = opened.offsets.get(id);
  if (at === undefined) return null;
  const probe = await probed(opened, at, opened.head.fileSize, opened.head);
  const header = E.readElement(probe, at);
  if (!readsAs(header, id)) return null;
  if (header.next - at > MAX_HEADER_ELEMENT_BYTES) return null;
  const window = await readPastHead(opened, at, header.next - at, probe);
  const element = E.readElement(window, at);
  return E.decoded(element) ? { window, element } : null;
}

function parseTracks(window: Window, tracks: Element): TrackEntry[] | RefusalCode {
  const entries: TrackEntry[] = [];
  const numbers = new Set<number>();
  let streamIndex = 0;
  for (const entry of E.children(window, tracks.body, tracks.size)) {
    if (entry.id !== E.ID.track.ENTRY) continue;
    const track: TrackEntry = {
      streamIndex: streamIndex++,
      number: -1,
      uid: null,
      codecId: "",
      codecPrivate: "",
      codecDelayNs: 0,
      type: -1,
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
      encoded: false,
    };
    for (const field of E.children(window, entry.body, entry.size)) {
      const { id } = field;
      if (id === E.ID.track.NUMBER) {
        const number = E.readUint(window, field);
        if (number === null) return "malformed";
        track.number = number;
      } else if (id === E.ID.track.UID) {
        track.uid = E.readUid(window, field);
      } else if (id === E.ID.track.TYPE) {
        const type = E.readUint(window, field);
        if (type === null) return "malformed";
        track.type = type;
      } else if (id === E.ID.track.CODEC_ID) {
        track.codecId = E.readAscii(window, field);
      } else if (id === E.ID.track.CODEC_PRIVATE) {
        track.codecPrivate = E.readUtf8(window, field);
      } else if (id === E.ID.track.CODEC_DELAY) {
        const delay = E.readUint(window, field);
        if (delay === null) return "malformed";
        track.codecDelayNs = delay;
      } else if (id === E.ID.track.LANGUAGE) {
        track.language = E.readAscii(window, field);
      } else if (id === E.ID.track.LANGUAGE_IETF) {
        track.languageIetf = E.readAscii(window, field);
      } else if (id === E.ID.track.NAME) {
        track.name = E.readUtf8(window, field);
      } else if (id === E.ID.track.FLAG_FORCED) {
        track.flags.forced = flagOf(window, field) ?? track.flags.forced;
      } else if (id === E.ID.track.FLAG_DEFAULT) {
        track.flags.default = flagOf(window, field) ?? track.flags.default;
      } else if (id === E.ID.track.FLAG_ENABLED) {
        track.flags.enabled = flagOf(window, field) ?? track.flags.enabled;
      } else if (id === E.ID.track.FLAG_HEARING_IMPAIRED) {
        track.flags.hearingImpaired = flagOf(window, field) ?? track.flags.hearingImpaired;
      } else if (id === E.ID.track.FLAG_VISUAL_IMPAIRED) {
        track.flags.visualImpaired = flagOf(window, field) ?? track.flags.visualImpaired;
      } else if (id === E.ID.track.FLAG_TEXT_DESCRIPTIONS) {
        track.flags.textDescriptions = flagOf(window, field) ?? track.flags.textDescriptions;
      } else if (id === E.ID.track.FLAG_ORIGINAL) {
        track.flags.original = flagOf(window, field) ?? track.flags.original;
      } else if (id === E.ID.track.FLAG_COMMENTARY) {
        track.flags.commentary = flagOf(window, field) ?? track.flags.commentary;
      } else if (id === E.ID.track.CONTENT_ENCODINGS) {
        track.encoded = true;
      }
    }
    if (track.number < 0) return "malformed";
    if (numbers.has(track.number)) return "malformed";
    numbers.add(track.number);
    entries.push(track);
  }
  return entries;
}

function parseTimestampScale(window: Window, info: Element): number {
  for (const field of E.children(window, info.body, info.size)) {
    if (field.id !== E.ID.info.TIMESTAMP_SCALE) continue;
    const scale = E.readUint(window, field);
    if (scale !== null && scale > 0) return scale;
  }
  return E.DEFAULT_TIMESTAMP_SCALE;
}

/**
 * The walk over a parent's children.
 *
 * null past the cap or the parent;
 * it stops at a child that does not read and hands back the last window.
 */
async function eachChildIn(
  opened: Located,
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
    window = await probed(opened, pos, parent.next, window);
    const field = E.readElement(window, pos);
    if (!E.decoded(field)) return window;
    if (!E.fits(field, parent.next)) return null;
    const next = await visit(pos, field, window);
    if (next === null) return null;
    window = next;
    pos = field.next;
  }
  return window;
}

async function readAttachments(opened: Opened): Promise<Attachment[]> {
  const at = opened.offsets.get(E.ID.segment.ATTACHMENTS);
  if (at === undefined) return [];
  const read = async (fallback: Attachment[]) => {
    const window = await probed(opened, at, opened.head.fileSize, opened.head);
    const attachments = E.readElement(window, at);
    if (!readsAs(attachments, E.ID.segment.ATTACHMENTS)) return fallback;
    const out: Attachment[] = [];
    const visit: Visit = async (_at, fileEl, held) => {
      if (fileEl.id !== E.ID.attachment.FILE) return held;
      const file = await readAttachedFile(opened, fileEl, held);
      if (file === null) return null;
      out.push(file.file);
      return file.window;
    };
    const last = await eachChildIn(opened, attachments, window, visit);
    return last === null ? fallback : out;
  };
  return optional([] as Attachment[], read);
}

async function readAttachedFile(
  opened: Opened,
  fileEl: Element,
  held: Window,
): Promise<{ file: Attachment; window: Window } | null> {
  const out: Attachment = { fileName: null, mimeType: null, description: null, size: 0, uid: null };
  const visit: Visit = async (at, field, carried) => {
    if (field.id === E.ID.attachment.FILE_DATA) {
      out.size = field.size;
      return carried;
    }
    if (field.next - at > ELEMENT_PROBE_BYTES) return carried;
    const window = await readPastHead(opened, at, field.next - at, carried);
    if (field.id === E.ID.attachment.FILE_NAME) {
      out.fileName = nulTrimmed(E.readUtf8(window, field));
    } else if (field.id === E.ID.attachment.FILE_MIME) {
      out.mimeType = E.readAscii(window, field);
    } else if (field.id === E.ID.attachment.FILE_DESCRIPTION) {
      out.description = nulTrimmed(E.readUtf8(window, field));
    } else if (field.id === E.ID.attachment.FILE_UID) {
      out.uid = E.readUid(window, field);
    }
    return window;
  };
  const last = await eachChildIn(opened, fileEl, held, visit);
  return last === null ? null : { file: out, window: last };
}

function parseInfo(window: Window, info: Element): ContainerInfo {
  const scale = parseTimestampScale(window, info);
  const out: ContainerInfo = { ...emptyInfo(), timestampScale: scale };
  for (const field of E.children(window, info.body, info.size)) {
    const { id } = field;
    if (id === E.ID.info.TITLE) {
      out.title = nulTrimmed(E.readUtf8(window, field));
    } else if (id === E.ID.info.MUXING_APP) {
      out.muxingApp = nulTrimmed(E.readUtf8(window, field));
    } else if (id === E.ID.info.WRITING_APP) {
      out.writingApp = nulTrimmed(E.readUtf8(window, field));
    } else if (id === E.ID.info.DURATION) {
      const ticks = E.readFloat(window, field);
      if (ticks !== null) {
        const ms = (ticks * scale) / 1_000_000;
        if (Number.isFinite(ms) && ms >= 0) {
          out.durationMs = ms;
        }
      }
    }
  }
  return out;
}

function parseTrackTags(window: Window, tags: Element): Map<string, TrackTag[]> {
  const bags = new Map<string, TrackTag[]>();
  for (const tag of E.children(window, tags.body, tags.size)) {
    if (tag.id !== E.ID.tag.ENTRY) continue;
    let uid: string | null = null;
    const tags: TrackTag[] = [];
    for (const field of E.children(window, tag.body, tag.size)) {
      if (field.id === E.ID.tag.TARGETS) {
        for (const target of E.children(window, field.body, field.size)) {
          if (target.id === E.ID.tag.TRACK_UID) {
            uid = E.readUid(window, target);
          }
        }
      } else if (field.id === E.ID.tag.SIMPLE) {
        tags.push(simpleTag(window, field));
      }
    }
    if (uid === null || tags.length === 0) continue;
    bags.set(uid, [...(bags.get(uid) ?? []), ...tags]);
  }
  return bags;
}
