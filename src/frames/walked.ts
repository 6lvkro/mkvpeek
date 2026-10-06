import type { WalkFetch, Watch } from "../io/source.js";
import { walkFrames } from "../matroska/clusters.js";
import { RefusalError } from "../vocabulary.js";
import type { FrameFile, TrackClaim } from "./claim.js";
import type { Frame } from "./contract.js";
import { frameOn, timelineOf } from "./timeline.js";

/** A track the walk found no frame of is refused after the walk where it states it has some. */
export async function* framesByWalk(
  file: FrameFile,
  claims: readonly TrackClaim[],
  knobs: WalkFetch,
  watch: Watch,
): AsyncGenerator<Frame> {
  const firstClusterTicks = await file.firstClusterTicks(watch.signal);
  const timeline = timelineOf(file, firstClusterTicks);
  const byNumber = new Map(claims.map((claim) => [claim.entry.number, claim] as const));
  const seen = new Set<TrackClaim>();
  for await (const clusterFrames of walkFrames(file, byNumber, knobs, watch)) {
    for (const frame of clusterFrames) {
      const claim = byNumber.get(frame.trackNumber) as TrackClaim;
      seen.add(claim);
      yield frameOn(frame, claim.entry.index, timeline);
    }
  }
  const unfound = claims.filter((claim) => !seen.has(claim));
  if (unfound.some(({ statedFrames }) => statedFrames !== null && statedFrames !== 0)) {
    throw new RefusalError("unreadable");
  }
}
