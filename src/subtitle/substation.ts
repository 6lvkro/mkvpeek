import type { Frame } from "../frames/contract.js";
import type { Track } from "../tracks.js";
import type { Assembler, Spool } from "./spool.js";
import { clockFields, ENCODER, MS_PER_SECOND, timesOf, UTF8 } from "./text.js";

interface Script {
  text: string;
  format: "ass" | "ssa";
}

/** A SubStation track is written in the format its script's head states, and not without a head. */
export function substationScript(track: Track): Script | null {
  if (track.codecPrivate === null) return null;
  const text = UTF8.decode(track.codecPrivate);
  const format = text === "" || cString(text).includes("\n[V4+ Styles]") ? "ass" : "ssa";
  return { text, format };
}

export function startSubstation({ text: script, format }: Script, out: Spool): Assembler {
  const searched = cString(script);
  const eventsAt = searched.indexOf("\n[Events]");
  const formatAt = eventsAt < 0 ? -1 : searched.indexOf("Format:", eventsAt);
  const formatEnd = formatAt < 0 ? -1 : searched.indexOf("\n", formatAt);
  const headEnd = formatEnd < 0 ? script.length : formatEnd + 1;
  const firstColumn = format === "ass" ? "Layer" : "Marked";
  const added =
    script !== "" && eventsAt < 0
      ? `[Events]\nFormat: ${firstColumn}, ${SUBSTATION_EVENT_COLUMNS}\n`
      : "";
  const headText = `${lines(script.slice(0, headEnd))}${added}`;
  const trailerText = lines(script.slice(headEnd));
  const opening = format === "ass" ? "Dialogue: " : `Dialogue: ${MARKED_PREFIX}`;
  out.write(headText);
  const order = new ReadOrder();
  const add = (frame: Frame) => {
    const dialogue = dialogueOf(frame, format);
    const released = order.admit(dialogue);
    writeDialogues(out, opening, released);
  };
  const end = () => {
    const rest = order.drain();
    writeDialogues(out, opening, rest);
    out.write(trailerText);
  };
  return { add, end };
}

interface Dialogue {
  order: CLong;
  layer: string;
  start: number;
  end: number;
  text: Uint8Array;
}

interface QueuedDialogue extends Dialogue {
  arrival: number;
}

/** A number C's strtol read, and where its reading stopped. */
interface LeadingNumber {
  value: CLong;
  end: number;
}

/** A C long, held as a number wherever a double holds it exactly. */
type CLong = number | bigint;

/** Lines in ReadOrder, each queued until every ReadOrder before it is out. */
class ReadOrder {
  readonly #queue: QueuedDialogue[] = [];
  #expected = 0;
  #arrivals = 0;

  admit(dialogue: Dialogue): Dialogue[] {
    const arrival = this.#arrivals;
    this.#arrivals += 1;
    if (this.#queue.length === 0 && dialogue.order === this.#expected) {
      this.#expected += 1;
      return [dialogue];
    }
    const queued = { ...dialogue, arrival };
    enqueue(this.#queue, queued);
    const released = [];
    while (this.#queue[0]?.order === this.#expected) {
      released.push(dequeue(this.#queue));
      this.#expected += 1;
    }
    return released;
  }

  drain(): Dialogue[] {
    const rest = [];
    while (this.#queue.length > 0) rest.push(dequeue(this.#queue));
    return rest;
  }
}

const CS_PER_SECOND = 100;
const MS_PER_CS = MS_PER_SECOND / CS_PER_SECOND;

const LAST_SUBSTATION_CS = 10 * 3600 * CS_PER_SECOND - 1;

/** The Format line's columns after its first. */
const SUBSTATION_EVENT_COLUMNS = "Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";

const MARKED_PREFIX = "Marked=";

const LONG_MAX = 2n ** 63n - 1n;
const LONG_MIN = -(2n ** 63n);

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** The most digits a double always holds exactly. */
const EXACT_DIGITS = 15;

/** H:MM:SS.CC, whose hours the ten-hour cap keeps to one digit. */
const TIME_BYTES = 10;

const NAN_TIME = "NaN:NaN:NaN.NaN";

/** The commas after the Layer and the two times, and the LF after the text. */
const LINE_PUNCTUATION_BYTES = 4;

const COMMA = 0x2c;
const COLON = 0x3a;
const DOT = 0x2e;
const SPACE = 0x20;
const TAB = 0x09;
const CR = 0x0d;
const LF = 0x0a;
const PLUS = 0x2b;
const MINUS = 0x2d;
const ZERO = 0x30;
const NINE = 0x39;
const CONTINUATION_LOW = 0x80;
const CONTINUATION_HIGH = 0xbf;

const cString = (text: string): string => text.split("\0", 1)[0] as string;

const timeBytes = (cs: number): number => (Number.isNaN(cs) ? NAN_TIME.length : TIME_BYTES);

const isCSpace = (byte: number): boolean => byte === SPACE || (byte >= TAB && byte <= CR);

const isDigit = (byte: number): boolean => byte >= ZERO && byte <= NINE;

const precedes = (a: QueuedDialogue, b: QueuedDialogue): boolean =>
  a.order < b.order || (a.order === b.order && a.arrival < b.arrival);

/** CR, LF and CRLF each end a line, and each is written ending in LF. */
function lines(text: string): string {
  const split = text.split(/\r\n|\r|\n/);
  if (split.at(-1) === "") split.pop();
  return split.map((line) => `${line}\n`).join("");
}

/** A field stops at a NUL as at any byte not its own, so only the text is cut at the first one. */
function dialogueOf(frame: Frame, format: "ass" | "ssa"): Dialogue {
  const { data } = frame;
  const nul = data.indexOf(0);
  const order = cStrtol(data, 0);
  const fieldAt = past(data, order.end, ",");
  const layerAt = format === "ass" ? fieldAt : past(data, fieldAt, MARKED_PREFIX);
  const layer = cStrtol(data, layerAt);
  const restAt = past(data, layer.end, ",");
  let restEnd = nul < 0 ? data.length : nul;
  while (data[restEnd - 1] === CR || data[restEnd - 1] === LF) {
    restEnd -= 1;
  }
  const rest = data.subarray(restAt, restEnd);
  const text = isUtf8(rest) ? rest : ENCODER.encode(UTF8.decode(rest));
  const [start, end] = timesOf(frame, MS_PER_CS);
  return { order: order.value, layer: String(layer.value), start, end, text };
}

function past(bytes: Uint8Array, at: number, prefix: string): number {
  for (let k = 0; k < prefix.length; k += 1) {
    if (bytes[at + k] !== prefix.charCodeAt(k)) return at;
  }
  return at + prefix.length;
}

function cStrtol(bytes: Uint8Array, at: number): LeadingNumber {
  let signAt = at;
  while (isCSpace(bytes[signAt] as number)) {
    signAt += 1;
  }
  const sign = bytes[signAt];
  const digitsAt = sign === PLUS || sign === MINUS ? signAt + 1 : signAt;
  let end = digitsAt;
  let small = 0;
  while (isDigit(bytes[end] as number)) {
    small = small * 10 + ((bytes[end] as number) - ZERO);
    end += 1;
  }
  if (end === digitsAt) return { value: 0, end: at };
  if (end - digitsAt > EXACT_DIGITS) return { value: wideLong(bytes, signAt, end), end };
  return { value: sign === MINUS ? -small : small, end };
}

/** A long of more digits than a double holds exactly, saturated as strtol does. */
function wideLong(bytes: Uint8Array, from: number, to: number): CLong {
  const digits = UTF8.decode(bytes.subarray(from, to));
  const stated = BigInt(digits);
  const capped = stated > LONG_MAX ? LONG_MAX : stated;
  const long = capped < LONG_MIN ? LONG_MIN : capped;
  const exact = long >= -MAX_SAFE && long <= MAX_SAFE;
  return exact ? Number(long) : long;
}

/**
 * Whether TextDecoder takes the bytes whole, by its UTF-8 decoder's steps up to the first error.
 *
 * @see {@link https://encoding.spec.whatwg.org/#utf-8-decoder}
 */
function isUtf8(bytes: Uint8Array): boolean {
  let needed = 0;
  let lower = CONTINUATION_LOW;
  let upper = CONTINUATION_HIGH;
  for (let at = 0; at < bytes.length; at += 1) {
    const byte = bytes[at] as number;
    if (needed > 0) {
      if (byte < lower || byte > upper) return false;
      lower = CONTINUATION_LOW;
      upper = CONTINUATION_HIGH;
      needed -= 1;
    } else if (byte >= 0xc2 && byte <= 0xdf) {
      needed = 1;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      needed = 2;
      if (byte === 0xe0) {
        lower = 0xa0;
      }
      if (byte === 0xed) {
        upper = 0x9f;
      }
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      needed = 3;
      if (byte === 0xf0) {
        lower = 0x90;
      }
      if (byte === 0xf4) {
        upper = 0x8f;
      }
    } else if (byte > 0x7f) {
      return false;
    }
  }
  return needed === 0;
}

/** The queue is a heap whose root goes out first. */
function enqueue(heap: QueuedDialogue[], queued: QueuedDialogue): void {
  heap.push(queued);
  let at = heap.length - 1;
  while (at > 0) {
    const parent = (at - 1) >> 1;
    const above = heap[parent] as QueuedDialogue;
    if (!precedes(queued, above)) return;
    heap[at] = above;
    heap[parent] = queued;
    at = parent;
  }
}

function dequeue(heap: QueuedDialogue[]): QueuedDialogue {
  const first = heap[0] as QueuedDialogue;
  const last = heap.pop() as QueuedDialogue;
  if (heap.length === 0) return first;
  heap[0] = last;
  let at = 0;
  for (;;) {
    const left = 2 * at + 1;
    let least = at;
    if (
      left < heap.length &&
      precedes(heap[left] as QueuedDialogue, heap[least] as QueuedDialogue)
    ) {
      least = left;
    }
    if (
      left + 1 < heap.length &&
      precedes(heap[left + 1] as QueuedDialogue, heap[least] as QueuedDialogue)
    ) {
      least = left + 1;
    }
    if (least === at) return first;
    heap[at] = heap[least] as QueuedDialogue;
    heap[least] = last;
    at = least;
  }
}

function writeDialogues(out: Spool, opening: string, dialogues: readonly Dialogue[]): void {
  let size = 0;
  for (const { layer, start, end, text } of dialogues) {
    size += opening.length + layer.length + timeBytes(start) + timeBytes(end) + text.length;
    size += LINE_PUNCTUATION_BYTES;
  }
  let at = out.reserve(size);
  for (const dialogue of dialogues) {
    at = writeDialogue(out.chunk, at, opening, dialogue);
  }
}

function writeDialogue(bytes: Uint8Array, at: number, opening: string, dialogue: Dialogue): number {
  const { layer, start, end, text } = dialogue;
  let next = writeAscii(bytes, at, opening);
  next = writeAscii(bytes, next, layer);
  bytes[next] = COMMA;
  next = writeTime(bytes, next + 1, start);
  bytes[next] = COMMA;
  next = writeTime(bytes, next + 1, end);
  bytes[next] = COMMA;
  bytes.set(text, next + 1);
  next += 1 + text.length;
  bytes[next] = LF;
  return next + 1;
}

function writeAscii(bytes: Uint8Array, at: number, ascii: string): number {
  for (let k = 0; k < ascii.length; k += 1) {
    bytes[at + k] = ascii.charCodeAt(k);
  }
  return at + ascii.length;
}

function writeTime(bytes: Uint8Array, at: number, cs: number): number {
  if (Number.isNaN(cs)) return writeAscii(bytes, at, NAN_TIME);
  const capped = Math.min(cs, LAST_SUBSTATION_CS);
  const { hours, minutes, seconds, fraction } = clockFields(capped, CS_PER_SECOND);
  bytes[at] = ZERO + hours;
  bytes[at + 1] = COLON;
  writeTwoDigits(bytes, at + 2, minutes);
  bytes[at + 4] = COLON;
  writeTwoDigits(bytes, at + 5, seconds);
  bytes[at + 7] = DOT;
  writeTwoDigits(bytes, at + 8, fraction);
  return at + TIME_BYTES;
}

function writeTwoDigits(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = ZERO + Math.floor(value / 10);
  bytes[at + 1] = ZERO + (value % 10);
}
