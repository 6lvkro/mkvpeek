/**
 * The engine that produces an envelope at header depth.
 *
 * Which kind of answer it becomes is decided by the projection plugged in.
 */

import * as E from "../ebml.js";
import { abortReason, type Source, stopIfAborted } from "../io/source.js";
import { readContainer, type TracksHeader } from "../matroska/header.js";
import type { Track } from "../tracks/core.js";
import { allTracks, type ListedTrack } from "../tracks/list.js";
import type { RefusalCode } from "../vocabulary.js";
import {
  absent,
  answerOf,
  type PeekOptions,
  type PeekOutcome,
  refused,
  served,
  wantsOf,
} from "./contract.js";

/**
 * Folds what was caught (an abort, a source failure, a grammar error) into a refusal.
 *
 * The caller picks the code for a grammar error; `error` is only asked whether it is one.
 */
export function thrownRefusal(
  error: unknown,
  grammarCode: "malformed" | "unreadable",
  signal: AbortSignal | undefined,
): RefusalCode {
  if (abortReason(signal) !== null) return "cancelled";
  if (!E.isGrammarError(error)) return "source-failed";
  return grammarCode;
}

export async function fromHeader<T extends Track>(
  source: Source,
  options: PeekOptions,
  projection: (header: TracksHeader) => T[],
): Promise<PeekOutcome<T>> {
  const wants = wantsOf(options);
  const absentAnswer = absent(wants);
  try {
    stopIfAborted(options.signal);
    const readOptions = { ...wants, signal: options.signal };
    const header = await readContainer(source, "tracks", readOptions);
    if (typeof header === "string") return refused(header, absentAnswer);
    const projected = projection(header);
    return served(answerOf(header, projected, wants));
  } catch (error) {
    const refusal = thrownRefusal(error, "malformed", options.signal);
    return refused(refusal, absentAnswer);
  }
}

export async function peekTracksFrom(
  source: Source,
  options: PeekOptions = {},
): Promise<PeekOutcome<ListedTrack>> {
  return fromHeader(source, options, allTracks);
}
