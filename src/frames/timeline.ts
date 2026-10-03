import type { ClaimedFrame } from "../matroska/block.js";
import { type TrackType, trackTypeOf } from "../tracks.js";
import type { RefusalCode } from "../vocabulary.js";
import type { FrameFile, TrackClaim } from "./claim.js";
import type { Frame } from "./contract.js";

interface Timeline {
  msPerTick: number;
  shiftMs: number;
}

export const frameOn = (frame: ClaimedFrame<TrackClaim>, timeline: Timeline): Frame => ({
  trackIndex: frame.claim.entry.index,
  startMs: frame.startTicks * timeline.msPerTick + timeline.shiftMs,
  durationMs: frame.durationTicks === null ? null : frame.durationTicks * timeline.msPerTick,
  data: frame.payload,
});

export function timelineOf(
  file: FrameFile,
  firstClusterTicks: number | null,
): Timeline | RefusalCode {
  const shiftMs = timelineShift(file, firstClusterTicks);
  if (shiftMs === null) {
    return "malformed";
  }
  return { msPerTick: file.info.timestampScale / NS_PER_MS, shiftMs };
}

const NS_PER_MS = 1_000_000;

const TIMELINE_TYPES: ReadonlySet<TrackType> = new Set(["video", "audio", "complex"]);

function timelineShift(
  { trackEntries, info }: FrameFile,
  firstClusterTicks: number | null,
): number | null {
  const delayNs = trackEntries.reduce((most, t) => Math.max(most, t.codecDelayNs), 0);
  const delayMs = Math.round(delayNs / NS_PER_MS);
  if (!trackEntries.some((t) => TIMELINE_TYPES.has(trackTypeOf(t)))) return delayMs;
  if (firstClusterTicks === null) return null;
  return delayMs - (firstClusterTicks * info.timestampScale) / NS_PER_MS;
}
