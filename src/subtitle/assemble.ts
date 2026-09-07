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
  const script = codecPrivate.replace(/\r\n/g, "\n");
  const headEnd = assHeadEnd(script);
  const ssaMode = /^\[V4 Styles\]/m.test(script);
  const head = script.slice(0, headEnd);
  const trailer = script.slice(headEnd);
  let body = "";
  for (const e of events) {
    const { layer: raw, middle, text } = splitAssPayload(e.payload);
    const marked = raw === "" ? "0" : raw;
    const layer = ssaMode ? `Marked=${marked}` : raw;
    const startCs = toCentiseconds(e.startMs);
    body += `Dialogue: ${layer},${assTime(startCs)},${assTime(startCs + toCentiseconds(e.durationMs))},${middle},${text}\n`;
  }
  const separator = head.endsWith("\n") ? "" : "\r\n";
  const written = `${head}${separator}${body === "" ? "\n" : body}${trailer}`;
  return written.endsWith("\n") ? written : `${written}\n`;
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
  return `WEBVTT\n${body === "" ? "\n\n" : body}`;
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

interface DialogSplit {
  layer: string;
  middle: string;
  text: string;
}

const DIALOGUE_LAYER_FIELD = 1;
const DIALOGUE_TEXT_FIELD = 8;

const MS_PER_SECOND = 1000;
const CS_PER_SECOND = 100;

const toCentiseconds = (ms: number): number => Math.round(ms / 10);

const padded = (n: number, width = 2): string => String(n).padStart(width, "0");

const padded2 = (n: number): string => (n < 10 ? `0${String(n)}` : String(n));

function splitAssPayload(payload: string): DialogSplit {
  const afterReadOrder = payload.indexOf(",");
  const afterLayer = payload.indexOf(",", afterReadOrder + 1);
  if (afterLayer < 0) return { layer: payload.slice(afterReadOrder + 1), middle: "", text: "" };

  let afterEffect = afterLayer;
  for (let field = DIALOGUE_LAYER_FIELD + 1; field < DIALOGUE_TEXT_FIELD; field++) {
    const next = payload.indexOf(",", afterEffect + 1);
    if (next < 0) {
      return {
        layer: payload.slice(afterReadOrder + 1, afterLayer),
        middle: payload.slice(afterLayer + 1),
        text: "",
      };
    }
    afterEffect = next;
  }
  return {
    layer: payload.slice(afterReadOrder + 1, afterLayer),
    middle: payload.slice(afterLayer + 1, afterEffect),
    text: payload.slice(afterEffect + 1),
  };
}

function assHeadEnd(script: string): number {
  const events = script.indexOf("\n[Events]");
  if (events < 0) return script.length;
  const format = script.indexOf("Format:", events);
  if (format < 0) return script.length;
  const eol = script.indexOf("\n", format);
  return eol < 0 ? script.length : eol + 1;
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
  const { hours, minutes, seconds, fraction } = clockFields(cs, CS_PER_SECOND);
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
