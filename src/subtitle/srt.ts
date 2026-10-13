import type { Frame } from "../frames/contract.js";
import type { Assembler, Spool } from "./spool.js";
import { clockFields, MS_PER_SECOND, padded, timesOf, UTF8 } from "./text.js";

export function startSrt(out: Spool): Assembler {
  let number = 0;
  const add = (frame: Frame) => {
    number += 1;
    const [start, end] = timesOf(frame, 1);
    const payload = UTF8.decode(frame.data);
    const event = `${String(number)}\n${srtTime(start)} --> ${srtTime(end)}\n${payload}\n\n`;
    out.write(event);
  };
  return { add };
}

function srtTime(ms: number): string {
  const { hours, minutes, seconds, fraction } = clockFields(ms, MS_PER_SECOND);
  return `${padded(hours)}:${padded(minutes)}:${padded(seconds)},${padded(fraction, 3)}`;
}
