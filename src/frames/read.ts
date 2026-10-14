import { linkedSignal, stopIfAborted, watchOver } from "../io/source.js";
import type { CuePosition, TrackEntry } from "../matroska/header.js";
import { refusalOf } from "../refusal.js";
import { RefusalError } from "../vocabulary.js";
import { claimFor, type FrameFile, type TrackClaim } from "./claim.js";
import type { Frame, FrameFinder, FrameVia } from "./contract.js";
import { framesByIndex, type IndexedGroup } from "./indexed.js";
import type { SettledFrameOptions } from "./tuning.js";
import { framesByWalk } from "./walked.js";

export async function* framesOf(
  file: FrameFile,
  entries: readonly TrackEntry[],
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
    if (entries.length === 0) return;
    const claims = claimsOf(file, entries);
    // The last cue whose frame the index handed over, past which a walk takes over.
    let through: CuePosition | undefined;
    if (via !== "walk") {
      const watch = watching("index");
      const groups = framesByIndex(file, claims, knobsForIndex, watch, strict);
      for (
        let next = await nextGroup(groups, via);
        next !== null;
        next = await nextGroup(groups, via)
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
    throw refusalOf(error, signal, "unreadable");
  } finally {
    unlink();
  }
}

/**
 * The index's next group, or null where it refused and the walk is to take over.
 *
 * Only the index's own failure is caught, so what a reader throws into the frames ends them.
 */
async function nextGroup(
  groups: AsyncGenerator<IndexedGroup>,
  via: FrameVia,
): Promise<IteratorResult<IndexedGroup> | null> {
  try {
    return await groups.next();
  } catch (error) {
    if (via === "index") throw error;
    return null;
  }
}

function claimsOf(file: FrameFile, entries: readonly TrackEntry[]): TrackClaim[] {
  const claims: TrackClaim[] = [];
  for (const entry of entries) {
    const claim = claimFor(entry, file);
    if (claim === null) throw new RefusalError("unreadable");
    claims.push(claim);
  }
  return claims;
}
