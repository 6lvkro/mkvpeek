import type { WalkFetch, Watch } from "../io/source.js";
import { type WalkFrom, walkFrames } from "../matroska/clusters.js";
import type { FrameFile, TrackClaim } from "./claim.js";
import type { Frame } from "./contract.js";
import { frameOn, timelineOf } from "./timeline.js";

export async function* framesByWalk(
  file: FrameFile,
  claims: readonly TrackClaim[],
  knobs: WalkFetch,
  watch: Watch,
  from?: WalkFrom,
): AsyncGenerator<Frame> {
  const firstClusterTicks = await file.firstClusterTicks(watch.signal);
  const timeline = timelineOf(file, firstClusterTicks);
  const byNumber = new Map(claims.map((claim) => [claim.entry.number, claim] as const));
  for await (const clusterFrames of walkFrames(file, byNumber, knobs, watch, from)) {
    for (const frame of clusterFrames) {
      const claim = byNumber.get(frame.trackNumber) as TrackClaim;
      yield frameOn(frame, claim.entry.index, timeline);
    }
  }
}
