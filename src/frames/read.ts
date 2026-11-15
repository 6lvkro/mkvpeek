import { linkedSignal, stopIfAborted, watchOver } from "../io/abort.js";
import type { BlockFrame } from "../matroska/block.js";
import type { CuePosition } from "../matroska/cues.js";
import type { OpenedTrack } from "../matroska/header.js";
import { walkFrames } from "../matroska/walked.js";
import { refusalOf } from "../refusal.js";
import { type RefusalCode, RefusalError } from "../vocabulary.js";
import { type ClaimsByNumber, claimFor, type TrackClaim } from "./claim.js";
import type { Frame, FrameFinder, FrameVia } from "./contract.js";
import type { FrameFile } from "./file.js";
import { framesByIndex, type IndexedGroup } from "./indexed.js";
import { frameOn } from "./timeline.js";
import type { SettledFrameOptions } from "./tuning.js";

export async function* framesOf(
  file: FrameFile,
  openedTracks: readonly OpenedTrack[],
  settled: SettledFrameOptions,
  closing: AbortSignal,
): AsyncGenerator<Frame> {
  const { signal, unlink } = linkedSignal(settled.signal, closing);
  try {
    stopIfAborted(signal);
    if (openedTracks.length === 0) return;
    const claims = claimsOf(openedTracks);
    for await (const batch of batchesOf(file, claims, settled, signal)) {
      // Popped, so each frame is let go as it is handed over.
      const pending = batch.reverse();
      for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
        stopIfAborted(signal);
        yield frame;
      }
    }
  } catch (error) {
    throw refusalOf(error, signal) ?? error;
  } finally {
    unlink();
  }
}

const WALK_TAKES_OVER: ReadonlySet<RefusalCode> = new Set(["unreadable", "source-failed"]);

async function* batchesOf(
  file: FrameFile,
  claims: ClaimsByNumber,
  { via, strict, knobsForIndex, knobsForWalk, onProgress }: SettledFrameOptions,
  signal: AbortSignal,
): AsyncGenerator<Frame[]> {
  const watching = (finder: FrameFinder) =>
    watchOver(signal, (doneBytes, totalBytes) => onProgress?.({ finder, doneBytes, totalBytes }));
  // The last cue whose frame the index handed over, past which a walk takes over.
  let through: CuePosition | undefined;
  if (via !== "walk") {
    const watch = watching("index");
    const groups = framesByIndex(file, claims, knobsForIndex, watch, strict);
    for (
      let next = await nextGroup(groups, via, signal);
      next !== null;
      next = await nextGroup(groups, via, signal)
    ) {
      if (next.done === true) return;
      yield next.value.frames;
      through = next.value.through;
    }
  }
  const watch = watching("walk");
  const timeline = await file.timeline(watch.signal);
  const onTimeline = (frame: BlockFrame) => {
    const claim = claims.get(frame.trackNumber) as TrackClaim;
    return frameOn(frame, claim.track.index, timeline);
  };
  for await (const clusterFrames of walkFrames(file, claims, knobsForWalk, watch, through)) {
    yield clusterFrames.map(onTimeline);
  }
}

async function nextGroup(
  groups: AsyncGenerator<IndexedGroup>,
  via: FrameVia,
  signal: AbortSignal,
): Promise<IteratorResult<IndexedGroup> | null> {
  try {
    return await groups.next();
  } catch (error) {
    const refusal = refusalOf(error, signal);
    if (refusal === null) throw error;
    if (via === "both" && WALK_TAKES_OVER.has(refusal.code)) return null;
    throw refusal;
  }
}

function claimsOf(openedTracks: readonly OpenedTrack[]): ClaimsByNumber {
  const claims = new Map<number, TrackClaim>();
  for (const openedTrack of openedTracks) {
    const claim = claimFor(openedTrack);
    if (claim === null) throw new RefusalError("unreadable");
    claims.set(openedTrack.track.number, claim);
  }
  return claims;
}
