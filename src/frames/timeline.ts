import type { BlockFrame } from "../matroska/block.js";
import { msOfTicks, type OpenedTrack } from "../matroska/header.js";
import { type ContainerInfo, RefusalError, type TrackType } from "../vocabulary.js";
import type { Frame } from "./contract.js";

export interface Timeline {
  nsPerTick: number;
  zeroTicks: number;
}

export const frameOn = (frame: BlockFrame, trackIndex: number, timeline: Timeline): Frame => ({
  trackIndex,
  startMs: msOfTicks(frame.startTicks - timeline.zeroTicks, timeline.nsPerTick),
  durationMs:
    frame.durationTicks === null ? null : msOfTicks(frame.durationTicks, timeline.nsPerTick),
  data: frame.payload,
});

export async function timelineOf(
  openedTracks: readonly OpenedTrack[],
  info: ContainerInfo,
  firstClusterTicks: () => Promise<number | null>,
): Promise<Timeline> {
  const media = openedTracks.some(({ track }) => TIMELINE_TYPES.has(track.type));
  const ticks = await firstClusterTicks();
  const firstTicks = media ? ticks : 0;
  if (firstTicks === null) throw new RefusalError("malformed");
  const nsPerTick = info.timestampScale;
  const delayNs = openedTracks.reduce((most, { track }) => Math.max(most, track.codecDelayNs), 0);
  return { nsPerTick, zeroTicks: firstTicks - Math.round(delayNs / nsPerTick) };
}

const TIMELINE_TYPES: ReadonlySet<TrackType> = new Set(["video", "audio", "complex"]);
