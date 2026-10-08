import type { Frame } from "../frames/contract.js";

interface Elapsed {
  hours: number;
  minutes: number;
  seconds: number;
  fraction: number;
}

export const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

export const ENCODER = new TextEncoder();

export const MS_PER_SECOND = 1000;

export const padded = (n: number, width = 2): string => String(n).padStart(width, "0");

export function timesOf(frame: Frame, msPerUnit: number): readonly [number, number] {
  const start = Math.round(frame.startMs / msPerUnit);
  return [start, start + Math.round((frame.durationMs ?? 0) / msPerUnit)];
}

export function clockFields(duration: number, perSecond: number): Elapsed {
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
