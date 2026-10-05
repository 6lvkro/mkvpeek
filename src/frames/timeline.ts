import type { ClaimedFrame } from "../matroska/block.js";
import { type TrackType, trackTypeOf } from "../tracks.js";
import type { RefusalCode } from "../vocabulary.js";
import type { FrameFile, TrackClaim } from "./claim.js";
import type { Frame } from "./contract.js";

interface Timeline {
  nsPerTick: number;
  zeroTicks: number;
}

export const frameOn = (frame: ClaimedFrame<TrackClaim>, timeline: Timeline): Frame => ({
  trackIndex: frame.claim.entry.index,
  startMs: msOf(frame.startTicks - timeline.zeroTicks, timeline),
  durationMs: frame.durationTicks === null ? null : msOf(frame.durationTicks, timeline),
  data: frame.payload,
});

export function timelineOf(
  { trackEntries, info }: FrameFile,
  firstClusterTicks: number | null,
): Timeline | RefusalCode {
  const media = trackEntries.some((t) => TIMELINE_TYPES.has(trackTypeOf(t)));
  const firstTicks = media ? firstClusterTicks : 0;
  if (firstTicks === null) return "malformed";
  const nsPerTick = info.timestampScale;
  const delayNs = trackEntries.reduce((most, t) => Math.max(most, t.codecDelayNs), 0);
  const startTicks = firstTicks - halfAway(delayNs / nsPerTick);
  const startUs = halfAway((startTicks * nsPerTick) / NS_PER_US);
  return { nsPerTick, zeroTicks: halfAway((startUs * NS_PER_US) / nsPerTick) };
}

const NS_PER_MS = 1_000_000;

const NS_PER_US = 1000;

const TIMELINE_TYPES: ReadonlySet<TrackType> = new Set(["video", "audio", "complex"]);

const msOf = (ticks: number, { nsPerTick }: Timeline): number => (ticks * nsPerTick) / NS_PER_MS;

const halfAway = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));
