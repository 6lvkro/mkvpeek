import type { Frame } from "../frames/contract.js";
import type { Track } from "../tracks.js";
import type { SubtitleFile } from "./contract.js";

/** A track's own frames as the file ffmpeg's -c:s copy writes, or null for a codec it does not write. */
export function assemble(track: Track, frames: readonly Frame[]): SubtitleFile | null {
  const assembler = ASSEMBLERS.get(track.codecId);
  return assembler === undefined ? null : assembler(track, frames);
}

type Assembler = (track: Track, frames: readonly Frame[]) => SubtitleFile | null;

interface Dialogue {
  order: bigint;
  line: string;
}

interface QueuedDialogue extends Dialogue {
  arrival: number;
}

interface VttCue {
  id: string;
  settings: string;
  text: string;
}

/** A number C's strtol read, and where its reading stopped. */
interface LeadingNumber {
  value: bigint;
  end: number;
}

interface Elapsed {
  hours: number;
  minutes: number;
  seconds: number;
  fraction: number;
}

const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

const MS_PER_SECOND = 1000;
const CS_PER_SECOND = 100;
const MS_PER_CS = MS_PER_SECOND / CS_PER_SECOND;

const LAST_SUBSTATION_CS = 10 * 3600 * CS_PER_SECOND - 1;

/** The Format line's columns after its first. */
const SUBSTATION_EVENT_COLUMNS = "Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";

const MARKED_PREFIX = "Marked=";

/** A number as C's strtol reads one in base 10. */
const C_LONG = /^[ \t\n\v\f\r]*([+-]?\d+)/;

const LONG_MAX = 2n ** 63n - 1n;
const LONG_MIN = -(2n ** 63n);

const ASSEMBLERS: ReadonlyMap<string, Assembler> = new Map<string, Assembler>([
  ...["S_TEXT/ASS", "S_TEXT/SSA", "S_SSA", "S_ASS"].map(
    (codec) => [codec, assembleSubstation] as const,
  ),
  ["S_TEXT/UTF8", assembleSrt],
  ["D_WEBVTT/SUBTITLES", assembleVtt],
  ["D_WEBVTT/CAPTIONS", assembleVtt],
]);

const padded = (n: number, width = 2): string => String(n).padStart(width, "0");

const cString = (text: string): string => text.split("\0", 1)[0] as string;

const past = (text: string, at: number, prefix: string): number =>
  text.startsWith(prefix, at) ? at + prefix.length : at;

const precedes = (a: QueuedDialogue, b: QueuedDialogue): boolean =>
  a.order < b.order || (a.order === b.order && a.arrival < b.arrival);

function assembleSubstation(track: Track, frames: readonly Frame[]): SubtitleFile | null {
  if (track.codecPrivate === null) return null;
  const script = UTF8.decode(track.codecPrivate);
  const searched = cString(script);
  const eventsAt = searched.indexOf("\n[Events]");
  const formatAt = eventsAt < 0 ? -1 : searched.indexOf("Format:", eventsAt);
  const formatEnd = formatAt < 0 ? -1 : searched.indexOf("\n", formatAt);
  const headEnd = formatEnd < 0 ? script.length : formatEnd + 1;
  const ssa = script !== "" && !searched.includes("\n[V4+ Styles]");
  const firstColumn = ssa ? "Marked" : "Layer";
  const added =
    script !== "" && eventsAt < 0
      ? `[Events]\nFormat: ${firstColumn}, ${SUBSTATION_EVENT_COLUMNS}\n`
      : "";
  const dialogues = frames.map((frame) => dialogueOf(frame, ssa));
  const written = inReadOrder(dialogues).map((line) => `Dialogue: ${line}\n`);
  const head = lines(script.slice(0, headEnd));
  const trailer = lines(script.slice(headEnd));
  const text = `${head}${added}${written.join("")}${trailer}`;
  return { track, format: ssa ? "ssa" : "ass", text };
}

function assembleSrt(track: Track, frames: readonly Frame[]): SubtitleFile {
  const events = frames.map((frame, i) => {
    const [start, end] = timesOf(frame, 1);
    const payload = UTF8.decode(frame.data);
    return `${String(i + 1)}\n${srtTime(start)} --> ${srtTime(end)}\n${payload}\n\n`;
  });
  return { track, format: "srt", text: events.join("") };
}

function assembleVtt(track: Track, frames: readonly Frame[]): SubtitleFile {
  const cues = frames.map((frame) => {
    const { id, settings, text } = vttCueOf(UTF8.decode(frame.data));
    const [start, end] = timesOf(frame, 1);
    const idLine = id === "" ? "" : `${id}\n`;
    const timingTail = settings === "" ? "" : ` ${settings}`;
    return `\n${idLine}${vttTime(start)} --> ${vttTime(end)}${timingTail}\n${text}\n`;
  });
  return { track, format: "vtt", text: `WEBVTT\n${cues.join("")}` };
}

/** CR, LF and CRLF each end a line, and each is written ending in LF. */
function lines(text: string): string {
  const split = text.split(/\r\n|\r|\n/);
  if (split.at(-1) === "") split.pop();
  return split.map((line) => `${line}\n`).join("");
}

function timesOf(frame: Frame, msPerUnit: number): readonly [number, number] {
  const start = Math.round(frame.startMs / msPerUnit);
  return [start, start + Math.round((frame.durationMs ?? 0) / msPerUnit)];
}

function dialogueOf(frame: Frame, ssa: boolean): Dialogue {
  const payload = cString(UTF8.decode(frame.data));
  const order = cStrtol(payload, 0);
  const fieldAt = past(payload, order.end, ",");
  const layerAt = ssa ? past(payload, fieldAt, MARKED_PREFIX) : fieldAt;
  const layer = cStrtol(payload, layerAt);
  const restAt = past(payload, layer.end, ",");
  const rest = lineEndsTrimmed(payload.slice(restAt));
  const [start, end] = timesOf(frame, MS_PER_CS);
  const lead = ssa ? MARKED_PREFIX : "";
  const line = `${lead}${String(layer.value)},${substationTime(start)},${substationTime(end)},${rest}`;
  return { order: order.value, line };
}

function cStrtol(text: string, at: number): LeadingNumber {
  const match = C_LONG.exec(text.slice(at));
  if (match === null) return { value: 0n, end: at };
  const stated = BigInt(match[1] as string);
  const capped = stated > LONG_MAX ? LONG_MAX : stated;
  return { value: capped < LONG_MIN ? LONG_MIN : capped, end: at + match[0].length };
}

/** Lines in ReadOrder, each queued until every ReadOrder before it is out. */
function inReadOrder(dialogues: readonly Dialogue[]): string[] {
  const written: string[] = [];
  const queue: QueuedDialogue[] = [];
  let expected = 0n;
  for (const [arrival, dialogue] of dialogues.entries()) {
    const queued: QueuedDialogue = { ...dialogue, arrival };
    enqueue(queue, queued);
    while (queue[0]?.order === expected) {
      written.push(dequeue(queue).line);
      expected += 1n;
    }
  }
  while (queue.length > 0) written.push(dequeue(queue).line);
  return written;
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

function lineEndsTrimmed(text: string): string {
  let end = text.length;
  while (text[end - 1] === "\r" || text[end - 1] === "\n") {
    end -= 1;
  }
  return text.slice(0, end);
}

function vttCueOf(payload: string): VttCue {
  const match = /^([^\r\n]*)(?:\r\n|\r(?!\n)|\n)([^\r\n]*)(?:\r\n|\r(?!\n)|\n)/.exec(payload);
  if (match === null) return { id: "", settings: "", text: lineEndsTrimmed(payload) };
  const id = match[1] as string;
  const settings = match[2] as string;
  return { id, settings, text: lineEndsTrimmed(payload.slice(match[0].length)) };
}

function clockFields(duration: number, perSecond: number): Elapsed {
  const at = Math.max(0, duration);
  const perMinute = 60 * perSecond;
  const perHour = 60 * perMinute;
  return {
    hours: Math.floor(at / perHour),
    minutes: Math.floor((at % perHour) / perMinute),
    seconds: Math.floor((at % perMinute) / perSecond),
    fraction: at % perSecond,
  };
}

function substationTime(cs: number): string {
  const capped = Math.min(cs, LAST_SUBSTATION_CS);
  const { hours, minutes, seconds, fraction } = clockFields(capped, CS_PER_SECOND);
  return `${String(hours)}:${padded(minutes)}:${padded(seconds)}.${padded(fraction)}`;
}

function vttTime(ms: number): string {
  const { hours, minutes, seconds, fraction } = clockFields(ms, MS_PER_SECOND);
  const belowHours = `${padded(minutes)}:${padded(seconds)}.${padded(fraction, 3)}`;
  return hours === 0 ? belowHours : `${padded(hours)}:${belowHours}`;
}

function srtTime(ms: number): string {
  const { hours, minutes, seconds, fraction } = clockFields(ms, MS_PER_SECOND);
  return `${padded(hours)}:${padded(minutes)}:${padded(seconds)},${padded(fraction, 3)}`;
}
