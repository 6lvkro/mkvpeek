import type { BlockFrame } from "../matroska/block.js";
import { type TrackType, trackTypeOf } from "../tracks.js";
import { RefusalError } from "../vocabulary.js";
import type { FrameFile } from "./claim.js";
import type { Frame } from "./contract.js";

export interface Timeline {
  nsPerTick: number;
  zeroTicks: number;
}

export const frameOn = (frame: BlockFrame, trackIndex: number, timeline: Timeline): Frame => ({
  trackIndex,
  startMs: msOf(frame.startTicks - timeline.zeroTicks, timeline),
  durationMs: frame.durationTicks === null ? null : msOf(frame.durationTicks, timeline),
  data: frame.payload,
});

export function timelineOf(
  { trackEntries, info }: FrameFile,
  firstClusterTicks: number | null,
): Timeline {
  const media = trackEntries.some((t) => TIMELINE_TYPES.has(trackTypeOf(t)));
  const firstTicks = media ? firstClusterTicks : 0;
  if (firstTicks === null) throw new RefusalError("malformed");
  const nsPerTick = info.timestampScale;
  const delayNs = trackEntries.reduce((most, t) => Math.max(most, t.codecDelayNs), 0);
  return { nsPerTick, zeroTicks: firstTicks - Math.round(delayNs / nsPerTick) };
}

const NS_PER_MS = 1_000_000;

const TIMELINE_TYPES: ReadonlySet<TrackType> = new Set(["video", "audio", "complex"]);

const msOf = (ticks: number, { nsPerTick }: Timeline): number => (ticks * nsPerTick) / NS_PER_MS;
