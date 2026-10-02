import type { Track } from "../tracks/core.js";
import type { Attachment, ContainerInfo, PeekCode, RefusalCode, Wants } from "../vocabulary.js";

/** The options every entry point shares. */
export interface PeekOptions {
  /** Opt in to container-level facts in the envelope. */
  info?: boolean;
  /** Opt in to attachment metadata in the envelope. */
  attachments?: boolean;
  /**
   * The signal that aborts the read.
   *
   * The returned {@linkcode PeekOutcome.code} is `cancelled`.
   *
   * @example
   * const stop = new AbortController();
   * const patience = setTimeout(() => stop.abort(), 5_000);
   * await peekTracks(url, { signal: stop.signal }).finally(() => clearTimeout(patience));
   */
  signal?: AbortSignal;
}

/**
 * The answer every read returns.
 *
 * Served or refused, it comes as a value and never as a throw.
 */
export interface PeekOutcome<T extends Track> extends HeaderAnswer<T> {
  code: PeekCode;
}

/** What the header answered, as one piece. */
interface HeaderAnswer<T extends Track> {
  /** Comes with a refusal too, as long as the header was read. */
  tracks: T[];
  info?: ContainerInfo | null;
  attachments?: Attachment[];
}

/** The two opt-in siblings, either what the header read or the absent answer. */
interface Siblings {
  info: ContainerInfo | null;
  attachments: Attachment[];
}

export const served = <T extends Track>(answer: HeaderAnswer<T>): PeekOutcome<T> => ({
  ...answer,
  code: "served",
});

/**
 * The outcome of a refusal.
 *
 * It carries the answer bought if the header was read, and {@linkcode absent} if it was not.
 */
export const refused = <T extends Track>(
  code: RefusalCode,
  answer: HeaderAnswer<T>,
): PeekOutcome<T> => ({
  ...answer,
  code,
});

export const wantsOf = (options: PeekOptions): Wants => ({
  info: options.info === true,
  attachments: options.attachments === true,
});

/**
 * The answer when the header was not read.
 *
 * No tracks can exist, and a requested sibling stands as its absent answer.
 */
export const absent = (wants: Wants): HeaderAnswer<never> => answerOf(ABSENT_SIBLINGS, [], wants);

/** An answer carrying only the siblings that were asked for. */
export function answerOf<T extends Track>(
  read: Siblings,
  tracks: T[],
  wants: Wants,
): HeaderAnswer<T> {
  const answer: HeaderAnswer<T> = { tracks };
  if (wants.info) {
    answer.info = read.info;
  }
  if (wants.attachments) {
    answer.attachments = read.attachments;
  }
  return answer;
}

/** The absent answer for siblings that were not read: info is null, attachments an empty list. */
const ABSENT_SIBLINGS: Siblings = { info: null, attachments: [] };
