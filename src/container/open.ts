import { disposable } from "../disposal.js";
import { claimFor } from "../frames/claim.js";
import type { Frame, FrameOptions } from "../frames/contract.js";
import type { FrameFile } from "../frames/file.js";
import { framesOf } from "../frames/read.js";
import { timelineOf } from "../frames/timeline.js";
import { settledFrameOptions } from "../frames/tuning.js";
import {
  abortReason,
  givenSignal,
  type Link,
  linkedSignal,
  stopIfAborted,
  untilAborted,
} from "../io/abort.js";
import type { Inflate, Source } from "../io/source.js";
import { readAttachments } from "../matroska/attachments.js";
import { readCues } from "../matroska/cues.js";
import {
  type OpenedSegment,
  type OpenedTrack,
  openSegment,
  readFirstClusterTicks,
  readInfo,
} from "../matroska/header.js";
import { refusalOf } from "../refusal.js";
import type { Abortable, Attachment, ContainerInfo, Track } from "../vocabulary.js";
import type { Container, Listing } from "./contract.js";
import { leaseOf, type Opener, type Target, type TargetLease } from "./target.js";

/** What the Node and browser entries do differently. */
export interface Platform {
  open: Opener;
  inflate: Inflate;
}

export async function peekWith(
  platform: Platform,
  target: Target,
  options: Abortable = {},
): Promise<Listing> {
  const container = await openWith(platform, target, options);
  const { tracks, info } = container;
  await container.close();
  return { tracks, info };
}

export async function openWith(
  platform: Platform,
  target: Target,
  options: Abortable = {},
): Promise<Container> {
  const signal = givenSignal({ ...options }.signal);
  try {
    const leasing = leaseOf(target, platform.open);
    const lease = await untilAborted(leasing, signal).catch((error: unknown) => {
      // The lease a stopped open still makes is let go when it arrives.
      void leasing.then(
        (late) => late.release?.(),
        () => {},
      );
      throw error;
    });
    return await leased(lease, platform.inflate, signal);
  } catch (error) {
    throw refusalOf(error, signal) ?? error;
  }
}

type PartRead<T> = (signal: AbortSignal) => Promise<T>;

interface SharedRead<T> {
  answer: Promise<T>;
  stop: Link;
  waiters: number;
}

class LeasedContainer implements Container {
  readonly tracks: Track[];
  readonly info: ContainerInfo;
  readonly #lease: TargetLease;
  readonly #file: FrameFile;
  readonly #attachments: PartRead<Attachment[]>;
  readonly #closing = new AbortController();
  readonly #pending: Set<Promise<unknown>>;
  #closed: Promise<void> | null = null;
  declare readonly [Symbol.asyncDispose]: () => Promise<void>;

  constructor(
    lease: TargetLease,
    held: OpenedSegment,
    info: ContainerInfo,
    pending: Set<Promise<unknown>>,
  ) {
    this.tracks = held.openedTracks.map(handedOut);
    this.info = { ...info };
    this.#lease = lease;
    this.#pending = pending;
    const closing = this.#closing.signal;
    this.#file = fileOf(held, info, closing);
    this.#attachments = sharedAndKept((signal) => readAttachments(held, signal), closing);
    disposable(this, () => this.close());
  }

  async attachments(options: Abortable = {}): Promise<Attachment[]> {
    const callerSignal = givenSignal({ ...options }.signal);
    const { signal, unlink } = linkedSignal(callerSignal, this.#closing.signal);
    try {
      stopIfAborted(signal);
      const kept = await this.#attachments(signal);
      return kept.map((attachment) => ({ ...attachment }));
    } catch (error) {
      throw refusalOf(error, signal) ?? error;
    } finally {
      unlink();
    }
  }

  readable(track: Track): boolean {
    const openedTrack = openedTrackOf(this.#file, track);
    return claimFor(openedTrack) !== null;
  }

  frames(tracks: readonly Track[], options: FrameOptions = {}): AsyncIterableIterator<Frame> {
    const openedTracks = openedTracksOf(this.#file, tracks);
    const callerOptions = { ...options };
    const settled = settledFrameOptions(callerOptions, this.#lease.source.trip);
    return framesOf(this.#file, openedTracks, settled, this.#closing.signal);
  }

  close(): Promise<void> {
    this.#closed ??= this.#shut();
    return this.#closed;
  }

  async #shut(): Promise<void> {
    this.#closing.abort();
    await Promise.allSettled(this.#pending);
    await this.#lease.release?.();
  }
}

async function leased(
  lease: TargetLease,
  inflate: Inflate,
  signal: AbortSignal | undefined,
): Promise<Container> {
  const pending = new Set<Promise<unknown>>();
  const source = withPendingCalls(lease.source, pending);
  // An open's sizes and reads race a link off its signal, which a failed open aborts to cut the rest.
  // A source that ignores the signal cannot hold the open.
  const link = linkedSignal(signal);
  const size: Source["size"] = (...args) => {
    const sizing = source.size(...args);
    return untilAborted(sizing, link.signal);
  };
  const read: Source["read"] = (...args) => {
    const reading = source.read(...args);
    return untilAborted(reading, link.signal);
  };
  const opening = { ...source, size, read };
  try {
    const opened = await openSegment(opening, link.signal, inflate);
    const info = await readInfo(opened, link.signal);
    const held = { ...opened, source };
    return new LeasedContainer(lease, held, info, pending);
  } catch (error) {
    link.abort(error);
    const releasing = Promise.allSettled(pending).then(() => lease.release?.());
    // The reads of an open its signal stopped may never end over a source that ignores the signal,
    // so then the release is not awaited.
    if (lease.release !== undefined && abortReason(signal) === null) await releasing;
    throw error;
  } finally {
    link.unlink();
  }
}

function withPendingCalls(source: Source, pending: Set<Promise<unknown>>): Source {
  const tracked = <T>(calling: Promise<T>) => {
    pending.add(calling);
    const forget = () => pending.delete(calling);
    calling.then(forget, forget);
    return calling;
  };
  const size: Source["size"] = (...args) => tracked(source.size(...args));
  const read: Source["read"] = (...args) => tracked(source.read(...args));
  return { ...source, size, read };
}

function handedOut({ track }: OpenedTrack): Track {
  const codecPrivate = track.codecPrivate === null ? null : track.codecPrivate.slice();
  const flags = { ...track.flags };
  const tags = track.tags.map((tag) => ({ ...tag }));
  return { ...track, codecPrivate, flags, tags };
}

function fileOf(opened: OpenedSegment, info: ContainerInfo, closing: AbortSignal): FrameFile {
  const firstClusterTicks = sharedAndKept(
    (signal) => readFirstClusterTicks(opened, signal),
    closing,
  );
  const cues = sharedAndKept((signal) => readCues(opened, signal), closing);
  const timeline = (signal: AbortSignal) => {
    const first = () => firstClusterTicks(signal);
    return timelineOf(opened.openedTracks, info, first);
  };
  return { ...opened, timeline, cues };
}

/**
 * A part read once for the callers that ask while it is read, and kept once a read of it succeeds.
 *
 * A caller whose signal fires stops waiting, and the read stops when no caller waits or the file closes.
 */
function sharedAndKept<T>(read: PartRead<T>, closing: AbortSignal): PartRead<T> {
  let kept: { value: T } | null = null;
  let shared: SharedRead<T> | null = null;
  const start = (): SharedRead<T> => {
    const stop = linkedSignal(closing);
    const answer = read(stop.signal);
    answer.then((value) => {
      kept = { value };
      stop.unlink();
    }, stop.unlink);
    return { answer, stop, waiters: 0 };
  };
  return async (signal) => {
    if (kept !== null) return kept.value;
    stopIfAborted(signal);
    shared ??= start();
    const current = shared;
    current.waiters += 1;
    try {
      return await untilAborted(current.answer, signal);
    } finally {
      current.waiters -= 1;
      if (current.waiters === 0) {
        shared = null;
        current.stop.abort();
      }
    }
  };
}

function openedTracksOf(file: FrameFile, tracks: readonly Track[]): OpenedTrack[] {
  const chosen = new Set<OpenedTrack>();
  for (const track of tracks) chosen.add(openedTrackOf(file, track));
  return file.openedTracks.filter((openedTrack) => chosen.has(openedTrack));
}

function openedTrackOf(file: FrameFile, track: Track): OpenedTrack {
  const { index } = track;
  const openedTrack = file.openedTracks[index];
  if (openedTrack !== undefined && statesTheSame(track, openedTrack.track)) return openedTrack;
  throw new TypeError(`track ${String(index)} is not a track of this file`);
}

function statesTheSame(given: unknown, own: unknown): boolean {
  if (typeof own !== "object" || own === null) return Object.is(given, own);
  if (own instanceof Uint8Array) return sameBytes(given, own);
  if (typeof given !== "object" || given === null) return false;
  const theirs = given as Record<string, unknown>;
  const ours = own as Record<string, unknown>;
  const keys = Object.keys(ours);
  const theirKeys = new Set(Object.keys(theirs));
  const sameKeys = keys.length === theirKeys.size && keys.every((key) => theirKeys.has(key));
  return sameKeys && keys.every((key) => statesTheSame(theirs[key], ours[key]));
}

function sameBytes(given: unknown, own: Uint8Array): boolean {
  if (!ArrayBuffer.isView(given)) return false;
  const items = given as Uint8Array;
  if (items.length !== own.length) return false;
  for (let at = 0; at < own.length; at++) {
    if (items[at] !== own[at]) return false;
  }
  return true;
}
