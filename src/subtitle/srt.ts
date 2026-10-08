import type { Frame } from "../frames/contract.js";
import { clockFields, ENCODER, MS_PER_SECOND, padded, timesOf, UTF8 } from "./text.js";

export function assembleSrt(frames: readonly Frame[]): Uint8Array {
  const events = frames.map((frame, i) => {
    const [start, end] = timesOf(frame, 1);
    const payload = UTF8.decode(frame.data);
    return `${String(i + 1)}\n${srtTime(start)} --> ${srtTime(end)}\n${payload}\n\n`;
  });
  return ENCODER.encode(events.join(""));
}

function srtTime(ms: number): string {
  const { hours, minutes, seconds, fraction } = clockFields(ms, MS_PER_SECOND);
  return `${padded(hours)}:${padded(minutes)}:${padded(seconds)},${padded(fraction, 3)}`;
}
