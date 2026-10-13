import { linkedSignal, stopIfAborted, watchOver } from "../io/source.js";
import type { TrackEntry } from "../matroska/header.js";
import { refusalOf } from "../refusal.js";
import { RefusalError } from "../vocabulary.js";
import { claimFor, type FrameFile, type TrackClaim } from "./claim.js";
import type { Frame, FrameFinder } from "./contract.js";
import { framesByIndex } from "./indexed.js";
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
    if (via !== "walk") {
      const watch = watching("index");
      const indexed = await framesByIndex(file, claims, knobsForIndex, watch, strict).catch(
        (error: unknown) => {
          if (via === "index") throw error;
          return null;
        },
      );
      if (indexed !== null) {
        // Popped, so each frame is let go as it is handed over.
        const pending = indexed.reverse();
        for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
          stopIfAborted(signal);
          yield frame;
        }
        return;
      }
    }
    const watch = watching("walk");
    for await (const frame of framesByWalk(file, claims, knobsForWalk, watch)) {
      stopIfAborted(signal);
      yield frame;
    }
  } catch (error) {
    throw refusalOf(error, signal, "unreadable");
  } finally {
    unlink();
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
