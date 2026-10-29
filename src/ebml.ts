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

export interface ElementCursor {
  id: number;
  size: number;
  body: number;
  next: number;
  open: boolean;
}

/** A view of part of the file, whose every coordinate is absolute. */
export interface Window {
  readonly at: number;
  readonly bytes: Uint8Array;
  readonly fileSize: number;
}

interface Vint {
  value: number;
  length: number;
}

type Unread = "unread";

/**
 * Thrown where a walk that stopped quietly
 * would turn a damaged list into a short one that looks whole.
 */
export class GrammarError extends Error {}

export const MAX_VINT_BYTES = 8;

export const headerNeed = (at: number, end: number): number =>
  Math.min(ELEMENT_HEADER_BYTES, end - at);

export const fits = (el: Element | OpenElement | Unread, end: number): el is Element =>
  decoded(el) && el.next <= end;

export const decoded = (el: Element | OpenElement | Unread): el is Element =>
  typeof el !== "string" && !("open" in el);

export const covers = (window: Window, at: number, length: number): boolean =>
  offsetOf(window, at, length) >= 0;

export const reachOf = (window: Window): number => window.at + window.bytes.length;

export const isGrammarError = (error: unknown): boolean => error instanceof GrammarError;

export const uintFits = (size: number): boolean => size <= MAX_VINT_BYTES;

export const elementCursor = (): ElementCursor => ({
  id: 0,
  size: 0,
  body: 0,
  next: 0,
  open: false,
});

export function throwUnlessGrammar(error: unknown): void {
  if (!isGrammarError(error)) throw error;
}

export function readVint(window: Window, at: number): Vint | Unread {
  const length = heldVintLength(window, at);
  if (length === 0) return "unread";
  const start = at - window.at;
  const value = vintValue(window.bytes, start, length, "size");
  return { value, length };
}

export function* children(window: Window, body: number, size: number): Generator<Element> {
  let at = body;
  const end = body + size;
  while (at < end) {
    const el = readElement(window, at);
    if (!fits(el, end)) throw new GrammarError();
    yield el;
    at = el.next;
  }
}

export function readElement(window: Window, at: number): Element | OpenElement | Unread {
  const cursor = SCRATCH;
  if (!readElementInto(window, at, cursor)) return "unread";
  const { id, body } = cursor;
  if (cursor.open) return { id, body, open: true };
  return { id, size: cursor.size, body, next: cursor.next };
}

export function readElementInto(window: Window, at: number, out: ElementCursor): boolean {
  const { bytes, fileSize } = window;
  const idLength = heldVintLength(window, at);
  if (idLength === 0) return false;
  const sizeAt = at + idLength;
  const sizeLength = heldVintLength(window, sizeAt);
  if (sizeLength === 0) return false;
  const sizeStart = sizeAt - window.at;
  const open = vintAllOnes(bytes, sizeStart, sizeLength);
  const size = open ? -1 : vintValue(bytes, sizeStart, sizeLength, "size");
  const body = sizeAt + sizeLength;
  if (!open && body + size > fileSize) return false;
  out.id = vintValue(bytes, at - window.at, idLength, "id");
  out.size = size;
  out.body = body;
  out.next = open ? -1 : body + size;
  out.open = open;
  return true;
}

export function readFloat(window: Window, el: Element): number | null {
  const bytes = readBytes(window, el.body, el.size);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (el.size === 4) return view.getFloat32(0);
  if (el.size === 8) return view.getFloat64(0);
  return null;
}

export function readUint(window: Window, el: Element): number {
  return readUintAt(window, el.body, el.size);
}

export function readUintAt(window: Window, at: number, size: number): number {
  const start = offsetOf(window, at, size);
  if (start < 0 || !uintFits(size)) throw new GrammarError();
  return uintValue(window.bytes, start, size);
}

export function readUid(window: Window, el: Element): string | null {
  if (!uintFits(el.size)) return null;
  let hex = "";
  for (const byte of readBytes(window, el.body, el.size)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  const trimmed = hex.replace(/^0+/, "");
  return trimmed === "" ? "0" : trimmed;
}

export function readAscii(window: Window, el: Element): string {
  const bytes = stringBytes(window, el);
  const chunks: string[] = [];
  for (let at = 0; at < bytes.length; at += ASCII_CHUNK_BYTES) {
    const chunk = bytes.subarray(at, at + ASCII_CHUNK_BYTES);
    chunks.push(String.fromCharCode(...chunk));
  }
  return chunks.join("");
}

export function readUtf8(window: Window, el: Element): string {
  return UTF8.decode(stringBytes(window, el));
}

export function readBytes(window: Window, at: number, length: number): Uint8Array {
  const start = offsetOf(window, at, length);
  if (start < 0) {
    throw new GrammarError();
  }
  return window.bytes.subarray(start, start + length);
}

const ELEMENT_HEADER_BYTES = 2 * MAX_VINT_BYTES;

const ALL_BITS = 0xff;

/** Bytes per String.fromCharCode call, well under the engine's limit on arguments. */
const ASCII_CHUNK_BYTES = 8192;

const KEEPS_BOM = { ignoreBOM: true };

const UTF8 = new TextDecoder("utf-8", KEEPS_BOM);

// readElement is synchronous, so its callers share one cursor without mixing their reads.
const SCRATCH = elementCursor();

function heldVintLength(window: Window, at: number): number {
  const start = offsetOf(window, at, 1);
  if (start < 0) return 0;
  const length = vintLength(window.bytes[start] as number);
  if (length > MAX_VINT_BYTES) return 0;
  return offsetOf(window, at, length) < 0 ? 0 : length;
}

function offsetOf(window: Window, at: number, length: number): number {
  const start = at - window.at;
  return start < 0 || start + length > window.bytes.length ? -1 : start;
}

function vintAllOnes(bytes: Uint8Array, start: number, length: number): boolean {
  const leadValueBits = ALL_BITS >> length;
  if (((bytes[start] as number) & leadValueBits) !== leadValueBits) return false;
  for (let i = 1; i < length; i++) {
    if (bytes[start + i] !== ALL_BITS) return false;
  }
  return true;
}

/**
 * A String or UTF-8 value ends at its first NUL.
 *
 * @see {@link https://www.rfc-editor.org/info/rfc8794/#section-13}
 */
function stringBytes(window: Window, el: Element): Uint8Array {
  const bytes = readBytes(window, el.body, el.size);
  const end = bytes.indexOf(0);
  return end === -1 ? bytes : bytes.subarray(0, end);
}

function vintLength(lead: number): number {
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
function vintValue(bytes: Uint8Array, start: number, length: number, as: "id" | "size"): number {
  const lead = bytes[start] as number;
  let value = as === "id" ? lead : lead & (ALL_BITS >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + (bytes[start + i] as number);
  }
  return value;
}

function uintValue(bytes: Uint8Array, start: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i++) {
    value = value * 256 + (bytes[start + i] as number);
  }
  return value;
}
