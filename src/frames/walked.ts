import type { Watch } from "../io/abort.js";
import type { WalkFetch } from "../io/source.js";
import { type WalkFrom, walkFrames } from "../matroska/walked.js";
import type { ClaimsByNumber, TrackClaim } from "./claim.js";
import type { Frame } from "./contract.js";
import type { FrameFile } from "./file.js";
import { frameOn } from "./timeline.js";

export async function* framesByWalk(
  file: FrameFile,
  claims: ClaimsByNumber,
  knobs: WalkFetch,
  watch: Watch,
  from?: WalkFrom,
): AsyncGenerator<Frame> {
  const timeline = await file.timeline(watch.signal);
  for await (const clusterFrames of walkFrames(file, claims, knobs, watch, from)) {
    for (const frame of clusterFrames) {
      const claim = claims.get(frame.trackNumber) as TrackClaim;
      yield frameOn(frame, claim.track.index, timeline);
    }
  }
}
