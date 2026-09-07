export interface Element {
  id: number;
  size: number;
  body: number;
  next: number;
}

/** An element that states no size. */
export interface OpenElement {
  id: number;
  body: number;
  open: true;
}

/**
 * A view of part of the file.
 *
 * Every coordinate is absolute, so it carries where it came from and how far the file goes.
 */
export interface Window {
  readonly at: number;
  readonly bytes: Uint8Array;
  readonly fileSize: number;
}

interface Vint {
  value: number;
  length: number;
  /** The all-ones shape that means the size is unknown. */
  allOnes: boolean;
}

/** Nothing could be read at some position. */
type Unread = "unread";

/**
 * Thrown where a walk that stopped quietly
 * would turn a damaged list into a short one that looks whole.
 *
 * {@linkcode isGrammarError} tells which it was.
 */
export class GrammarError extends Error {}

export const DEFAULT_TIMESTAMP_SCALE = 1_000_000;

/**
 * The widest a vint gets.
 *
 * Every header-size constant downstream derives from this number.
 */
export const MAX_VINT_BYTES = 8;

/**
 * The element ids this reader knows.
 *
 * @see {@link https://www.matroska.org/technical/elements.html}
 */
export const ID = {
  root: {
    EBML: 0x1a45dfa3,
    SEGMENT: 0x18538067,
  },
  segment: {
    SEEK_HEAD: 0x114d9b74,
    INFO: 0x1549a966,
    TRACKS: 0x1654ae6b,
    TAGS: 0x1254c367,
    CUES: 0x1c53bb6b,
    CLUSTER: 0x1f43b675,
    CHAPTERS: 0x1043a770,
    ATTACHMENTS: 0x1941a469,
  },
  seek: {
    ENTRY: 0x4dbb,
    ID: 0x53ab,
    POSITION: 0x53ac,
  },
  info: {
    TIMESTAMP_SCALE: 0x2ad7b1,
    TITLE: 0x7ba9,
    MUXING_APP: 0x4d80,
    WRITING_APP: 0x5741,
    DURATION: 0x4489,
  },
  track: {
    ENTRY: 0xae,
    NUMBER: 0xd7,
    UID: 0x73c5,
    TYPE: 0x83,
    CODEC_ID: 0x86,
    CODEC_PRIVATE: 0x63a2,
    CODEC_DELAY: 0x56aa,
    LANGUAGE: 0x22b59c,
    LANGUAGE_IETF: 0x22b59d,
    NAME: 0x536e,
    FLAG_DEFAULT: 0x88,
    FLAG_FORCED: 0x55aa,
    FLAG_ENABLED: 0xb9,
    FLAG_HEARING_IMPAIRED: 0x55ab,
    FLAG_VISUAL_IMPAIRED: 0x55ac,
    FLAG_TEXT_DESCRIPTIONS: 0x55ad,
    FLAG_ORIGINAL: 0x55ae,
    FLAG_COMMENTARY: 0x55af,
    CONTENT_ENCODINGS: 0x6d80,
  },
  attachment: {
    FILE: 0x61a7,
    FILE_NAME: 0x466e,
    FILE_MIME: 0x4660,
    FILE_DESCRIPTION: 0x467e,
    FILE_DATA: 0x465c,
    FILE_UID: 0x46ae,
  },
  tag: {
    ENTRY: 0x7373,
    TARGETS: 0x63c0,
    TRACK_UID: 0x63c5,
    SIMPLE: 0x67c8,
    NAME: 0x45a3,
    STRING: 0x4487,
  },
  cue: {
    POINT: 0xbb,
    TRACK_POSITIONS: 0xb7,
    TRACK: 0xf7,
    CLUSTER_POSITION: 0xf1,
    RELATIVE_POSITION: 0xf0,
  },
  cluster: {
    TIMESTAMP: 0xe7,
    SIMPLE_BLOCK: 0xa3,
    BLOCK_GROUP: 0xa0,
    POSITION: 0xa7,
    PREV_SIZE: 0xab,
    SILENT_TRACKS: 0x5854,
    ENCRYPTED_BLOCK: 0xaf,
  },
  blockGroup: {
    BLOCK: 0xa1,
    BLOCK_DURATION: 0x9b,
  },
  global: {
    CRC32: 0xbf,
    VOID: 0xec,
  },
} as const;

/** Decoded as a sized element. */
export const decoded = (el: Element | OpenElement | Unread): el is Element =>
  typeof el !== "string" && !("open" in el);

/** Decoded as a sized element that ends within its parent. */
export const fits = (el: Element | OpenElement | Unread, end: number): el is Element =>
  decoded(el) && el.next <= end;

export const covers = (window: Window, at: number, length: number): boolean =>
  offsetOf(window, at, length) >= 0;

export const reachOf = (window: Window): number => window.at + window.bytes.length;

export const isGrammarError = (error: unknown): boolean => error instanceof GrammarError;

export const decodeUtf8 = (bytes: Uint8Array): string => UTF8.decode(bytes);

export const uintFits = (size: number): boolean => size <= MAX_VINT_BYTES;

export function readVint(window: Window, at: number, as: "id" | "size"): Vint | Unread {
  const start = offsetOf(window, at, 1);
  if (start < 0) return "unread";
  const length = vintLength(window.bytes[start] as number);
  if (length > MAX_VINT_BYTES) return "unread";
  if (offsetOf(window, at, length) < 0) return "unread";
  const value = vintValue(window.bytes, start, length, as);
  const allOnes = vintAllOnes(window.bytes, start, length);
  return { value, length, allOnes };
}

export function vintLength(lead: number): number {
  let length = 1;
  while (length <= MAX_VINT_BYTES && (lead & (0x80 >> (length - 1))) === 0) {
    length += 1;
  }
  return length;
}

/**
 * The value of a vint whose length is known.
 *
 * `id` keeps the marker bit so the value compares to the constants as is; `size` drops it.
 */
export function vintValue(
  bytes: Uint8Array,
  start: number,
  length: number,
  as: "id" | "size",
): number {
  const lead = bytes[start] as number;
  let value = as === "id" ? lead : lead & (ALL_BITS >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + (bytes[start + i] as number);
  }
  return value;
}

/** The all-ones shape of a size vint, which means the size is unknown. */
export function vintAllOnes(bytes: Uint8Array, start: number, length: number): boolean {
  const leadValueBits = ALL_BITS >> length;
  if (((bytes[start] as number) & leadValueBits) !== leadValueBits) return false;
  for (let i = 1; i < length; i++) {
    if (bytes[start + i] !== ALL_BITS) return false;
  }
  return true;
}

export function uintAt(bytes: Uint8Array, start: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i++) {
    value = value * 256 + (bytes[start + i] as number);
  }
  return value;
}

export function readElement(window: Window, at: number): Element | OpenElement | Unread {
  const { fileSize } = window;
  const id = readVint(window, at, "id");
  if (typeof id === "string") return id;
  const size = readVint(window, at + id.length, "size");
  if (typeof size === "string") return size;
  const body = at + id.length + size.length;
  if (size.allOnes) {
    if (id.value !== ID.root.SEGMENT && id.value !== ID.segment.CLUSTER) return "unread";
    return { id: id.value, body, open: true };
  }
  if (body + size.value > fileSize) return "unread";
  return { id: id.value, size: size.value, body, next: body + size.value };
}

export function* children(window: Window, body: number, size: number): Generator<Element> {
  let at = body;
  const end = body + size;
  while (at < end) {
    const el = readElement(window, at);
    const invalidGrammar = typeof el === "string" || "open" in el || el.next > end;
    if (invalidGrammar) throw new GrammarError();
    yield el;
    at = el.next;
  }
}

export function readFloat(window: Window, el: Element): number | null {
  const bytes = readBytes(window, el.body, el.size);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (el.size === 4) return view.getFloat32(0);
  if (el.size === 8) return view.getFloat64(0);
  return null;
}

export function readUint(window: Window, el: Element): number | null {
  if (!uintFits(el.size)) return null;
  const start = offsetOf(window, el.body, el.size);
  if (start < 0) throw new GrammarError();
  return uintAt(window.bytes, start, el.size);
}

export function readUid(window: Window, el: Element): string | null {
  let hex = "";
  for (const byte of readBytes(window, el.body, el.size)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  const trimmed = hex.replace(/^0+/, "");
  return trimmed === "" ? null : trimmed;
}

export function readAscii(window: Window, el: Element): string {
  let out = "";
  for (const byte of readBytes(window, el.body, el.size)) {
    out += String.fromCharCode(byte);
  }
  return out.replace(/\0+$/, "");
}

export function readUtf8(window: Window, el: Element): string {
  return decodeUtf8(readBytes(window, el.body, el.size));
}

export function readBytes(window: Window, at: number, length: number): Uint8Array {
  const start = offsetOf(window, at, length);
  if (start < 0) {
    throw new GrammarError();
  }
  return window.bytes.subarray(start, start + length);
}

const ALL_BITS = 0xff;

const KEEPS_BOM = { ignoreBOM: true };

const UTF8 = new TextDecoder("utf-8", KEEPS_BOM);

function offsetOf(window: Window, at: number, length: number): number {
  const start = at - window.at;
  return start < 0 || start + length > window.bytes.length ? -1 : start;
}
