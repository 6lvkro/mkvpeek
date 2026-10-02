/**
 * The engine that produces an envelope at header depth.
 *
 * Which kind of answer it becomes is decided by the projection plugged in.
 */

import type { Source } from "../io/source.js";
import { readContainer, type TracksHeader } from "../matroska/header.js";
import { refusalOf, returnedRefusal } from "../refusal.js";
import type { Track } from "../tracks/core.js";
import { allTracks, type ListedTrack } from "../tracks/list.js";
import {
  absent,
  answerOf,
  type PeekOptions,
  type PeekOutcome,
  refused,
  served,
  wantsOf,
} from "./contract.js";
import { leaseOf, type Opener, type Target } from "./target.js";

/** What an entry lends the operations: how a string target opens. */
export interface Platform {
  open: Opener;
}

/** One operation's work over the source a target became. */
type Work<T extends Track, O extends PeekOptions> = (
  source: Source,
  options: O,
) => Promise<PeekOutcome<T>>;

/** Runs an operation over a target, leased for it and released after it, a refusal answered in the envelope. */
export async function peekWith<T extends Track, O extends PeekOptions>(
  platform: Platform,
  target: Target,
  options: O,
  work: Work<T, O>,
): Promise<PeekOutcome<T>> {
  const asked = { ...options };
  try {
    const lease = await leaseOf(target, platform.open);
    try {
      return await work(lease.source, asked);
    } finally {
      await lease.release?.();
    }
  } catch (error) {
    const refusal = refusalOf(error, asked.signal);
    const wants = wantsOf(asked);
    const absentAnswer = absent(wants);
    return refused(refusal, absentAnswer);
  }
}

export async function fromHeader<T extends Track>(
  source: Source,
  options: PeekOptions,
  projection: (header: TracksHeader) => T[],
): Promise<PeekOutcome<T>> {
  const wants = wantsOf(options);
  const absentAnswer = absent(wants);
  try {
    const readOptions = { ...wants, signal: options.signal };
    const header = await readContainer(source, "tracks", readOptions);
    if (typeof header === "string") {
      const refusal = returnedRefusal(header, options.signal);
      return refused(refusal, absentAnswer);
    }
    const projected = projection(header);
    return served(answerOf(header, projected, wants));
  } catch (error) {
    const refusal = refusalOf(error, options.signal);
    return refused(refusal, absentAnswer);
  }
}

export async function peekTracksFrom(
  source: Source,
  options: PeekOptions = {},
): Promise<PeekOutcome<ListedTrack>> {
  return fromHeader(source, options, allTracks);
}
