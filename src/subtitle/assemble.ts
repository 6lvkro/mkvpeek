export interface Event {
  readOrder: number | null;
  startMs: number;
  durationMs: number;
  payload: string;
}

export interface Timeline {
  msPerTick: number;
  shiftMs: number;
}

interface TickedFrame {
  readOrder: number | null;
  startTicks: number;
  durationTicks: number | null;
  payload: string;
}

export const eventOf = (frame: TickedFrame, timeline: Timeline): Event => ({
  readOrder: frame.readOrder,
  startMs: frame.startTicks * timeline.msPerTick + timeline.shiftMs,
  durationMs: (frame.durationTicks ?? 0) * timeline.msPerTick,
  payload: frame.payload,
});

export function assembleAss(codecPrivate: string, events: readonly Event[]): string {
  const searched = cString(codecPrivate);
  const eventsAt = searched.indexOf("\n[Events]");
  const formatAt = eventsAt < 0 ? -1 : searched.indexOf("Format:", eventsAt);
  const formatEnd = formatAt < 0 ? -1 : searched.indexOf("\n", formatAt);
  const headEnd = formatEnd < 0 ? codecPrivate.length : formatEnd + 1;
  const ssa = codecPrivate !== "" && !searched.includes("\n[V4+ Styles]");
  const firstColumn = ssa ? "Marked" : "Layer";
  const added =
    codecPrivate !== "" && eventsAt < 0
      ? `[Events]\nFormat: ${firstColumn}, ${EVENT_COLUMNS}\n`
      : "";
  const dialogues = events.map((e) => `Dialogue: ${dialogueOf(e, ssa)}\n`);
  const head = lines(codecPrivate.slice(0, headEnd));
  const trailer = lines(codecPrivate.slice(headEnd));
  return `${head}${added}${dialogues.join("")}${trailer}`;
}

export function assembleVtt(events: readonly Event[]): string {
  let body = "";
  for (const e of events) {
    const lines = e.payload.replace(/\r\n?/g, "\n").split("\n");
    const whole = lines.length >= 3;
    const id = whole ? (lines[0] as string) : "";
    const settings = whole ? (lines[1] as string) : "";
    const text = (whole ? lines.slice(2) : lines).join("\n").replace(/\n$/, "");
    const start = Math.round(e.startMs);
    const at = `${vttTime(start)} --> ${vttTime(start + Math.round(e.durationMs))}`;
    const head = id === "" ? "" : `${id}\n`;
    body += `\n${head}${at}${settings === "" ? "" : ` ${settings}`}\n${text}\n`;
  }
  return `WEBVTT\n${body}`;
}

export function assembleSrt(events: readonly Event[]): string {
  let body = "";
  let sequence = 0;
  for (const e of events) {
    sequence += 1;
    const start = Math.round(e.startMs);
    const text = e.payload.replace(/\r\n/g, "\n").replace(/\n$/, "");
    body += `${String(sequence)}\n${srtTime(start)} --> ${srtTime(start + Math.round(e.durationMs))}\n${text}\n\n`;
  }
  return body;
}

interface Elapsed {
  hours: number;
  minutes: number;
  seconds: number;
  fraction: number;
}

interface LeadingNumber {
  value: string;
  end: number;
}

const MARKED_PREFIX = "Marked=";

/** The Format line's columns after its first. */
const EVENT_COLUMNS = "Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";

/** A number as C's strtol reads one in base 10. */
const C_LONG = /^[ \t\n\v\f\r]*([+-]?\d+)/;
const LONG_MAX = 2n ** 63n - 1n;
const LONG_MIN = -(2n ** 63n);

const MS_PER_SECOND = 1000;
const CS_PER_SECOND = 100;

const LAST_ASS_CS = 10 * 3600 * CS_PER_SECOND - 1;

const toCentiseconds = (ms: number): number => Math.round(ms / 10);

const padded = (n: number, width = 2): string => String(n).padStart(width, "0");

const padded2 = (n: number): string => (n < 10 ? `0${String(n)}` : String(n));

const cString = (text: string): string => text.split("\0", 1)[0] as string;

const past = (text: string, at: number, what: string): number =>
  text.startsWith(what, at) ? at + what.length : at;

function dialogueOf(e: Event, ssa: boolean): string {
  const payload = cString(e.payload);
  const order = cStrtol(payload, 0);
  const fieldAt = past(payload, order.end, ",");
  const layerAt = ssa ? past(payload, fieldAt, MARKED_PREFIX) : fieldAt;
  const layer = cStrtol(payload, layerAt);
  const textAt = past(payload, layer.end, ",");
  const rest = payload.slice(textAt).replace(/[\r\n]+$/, "");
  const startCs = toCentiseconds(e.startMs);
  const endCs = startCs + toCentiseconds(e.durationMs);
  const lead = ssa ? MARKED_PREFIX : "";
  return `${lead}${layer.value},${assTime(startCs)},${assTime(endCs)},${rest}`;
}

function cStrtol(text: string, from: number): LeadingNumber {
  const read = C_LONG.exec(text.slice(from));
  if (read === null) return { value: "0", end: from };
  const stated = BigInt(read[1] as string);
  const capped = stated > LONG_MAX ? LONG_MAX : stated;
  const value = capped < LONG_MIN ? LONG_MIN : capped;
  return { value: String(value), end: from + read[0].length };
}

/** CR, LF and CRLF each end a line, and each is written ending in LF. */
function lines(text: string): string {
  const split = text.split(/\r\n|\r|\n/);
  if (split.at(-1) === "") split.pop();
  return split.map((line) => `${line}\n`).join("");
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

function assTime(cs: number): string {
  const written = Math.min(cs, LAST_ASS_CS);
  const { hours, minutes, seconds, fraction } = clockFields(written, CS_PER_SECOND);
  return `${String(hours)}:${padded2(minutes)}:${padded2(seconds)}.${padded2(fraction)}`;
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
