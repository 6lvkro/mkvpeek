import { linkedSignal, stopIfAborted, watchOver } from "../io/abort.js";
import type { CuePosition } from "../matroska/cues.js";
import type { OpenedTrack } from "../matroska/header.js";
import { refusalOf } from "../refusal.js";
import { type RefusalCode, RefusalError } from "../vocabulary.js";
import { type ClaimsByNumber, claimFor, type TrackClaim } from "./claim.js";
import type { Frame, FrameFinder, FrameVia } from "./contract.js";
import type { FrameFile } from "./file.js";
import { framesByIndex, type IndexedGroup } from "./indexed.js";
import type { SettledFrameOptions } from "./tuning.js";
import { framesByWalk } from "./walked.js";

export async function* framesOf(
  file: FrameFile,
  openedTracks: readonly OpenedTrack[],
  {
    via,
    strict,
    knobsForIndex,
    knobsForWalk,
    onProgress,
    signal: callerSignal,
  }: SettledFrameOptions,
  closing: AbortSignal,
): AsyncGenerator<Frame> {
  const { signal, unlink } = linkedSignal(callerSignal, closing);
  const watching = (finder: FrameFinder) =>
    watchOver(signal, (doneBytes, totalBytes) => onProgress?.({ finder, doneBytes, totalBytes }));
  try {
    stopIfAborted(signal);
    if (openedTracks.length === 0) return;
    const claims = claimsOf(openedTracks);
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
        // Popped, so each frame is let go as it is handed over.
        const pending = next.value.frames.reverse();
        for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
          stopIfAborted(signal);
          yield frame;
        }
        through = next.value.through;
      }
    }
    const watch = watching("walk");
    for await (const frame of framesByWalk(file, claims, knobsForWalk, watch, through)) {
      stopIfAborted(signal);
      yield frame;
    }
  } catch (error) {
    throw refusalOf(error, signal);
  } finally {
    unlink();
  }
}

const WALK_TAKES_OVER: ReadonlySet<RefusalCode> = new Set(["unreadable", "source-failed"]);

async function nextGroup(
  groups: AsyncGenerator<IndexedGroup>,
  via: FrameVia,
  signal: AbortSignal,
): Promise<IteratorResult<IndexedGroup> | null> {
  try {
    return await groups.next();
  } catch (error) {
    const refusal = refusalOf(error, signal);
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
