import type { Frame } from "../frames/contract.js";
import { clockFields, ENCODER, MS_PER_SECOND, padded, timesOf, UTF8 } from "./text.js";

export function assembleVtt(frames: readonly Frame[]): Uint8Array {
  const cues = frames.map((frame) => {
    const { id, settings, text } = vttCueOf(UTF8.decode(frame.data));
    const [start, end] = timesOf(frame, 1);
    const idLine = id === "" ? "" : `${id}\n`;
    const timingTail = settings === "" ? "" : ` ${settings}`;
    return `\n${idLine}${vttTime(start)} --> ${vttTime(end)}${timingTail}\n${text}\n`;
  });
  return ENCODER.encode(`WEBVTT\n${cues.join("")}`);
}

interface VttCue {
  id: string;
  settings: string;
  text: string;
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

function vttTime(ms: number): string {
  const { hours, minutes, seconds, fraction } = clockFields(ms, MS_PER_SECOND);
  const belowHours = `${padded(minutes)}:${padded(seconds)}.${padded(fraction, 3)}`;
  return hours === 0 ? belowHours : `${padded(hours)}:${belowHours}`;
}
