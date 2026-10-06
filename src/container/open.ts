import { disposable } from "../disposal.js";
import { claimFor, type FrameFile } from "../frames/claim.js";
import type { Frame, FrameOptions } from "../frames/contract.js";
import { framesOf } from "../frames/read.js";
import { settledFrameOptions } from "../frames/tuning.js";
import {
  givenSignal,
  type Inflate,
  type Link,
  linkedSignal,
  type Source,
  stopIfAborted,
  untilAborted,
} from "../io/source.js";
import {
  type OpenedSegment,
  openSegment,
  readAttachments,
  readCues,
  readFirstClusterTicks,
  readInfo,
  type TrackEntry,
} from "../matroska/header.js";
import { refusalOf } from "../refusal.js";
import { allTracks, type Track, trackOf } from "../tracks.js";
import {
  type Abortable,
  type Attachment,
  type ContainerInfo,
  RefusalError,
} from "../vocabulary.js";
import type { Container, Listing } from "./contract.js";
import { leaseOf, type Opener, type Target, type TargetLease } from "./target.js";

/** What the Node and browser entries do differently. */
export interface Platform {
  open: Opener;
  inflate: Inflate;
}

export async function openWith(
  platform: Platform,
  target: Target,
  options: Abortable = {},
): Promise<Container> {
  const signal = givenSignal({ ...options }.signal);
  try {
    const lease = await leaseOf(target, platform.open);
    return await leased(lease, platform.inflate, signal);
  } catch (error) {
    const refusal = refusalOf(error, signal);
    throw new RefusalError(refusal);
  }
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
  readonly #pending = new Set<Promise<unknown>>();
  #closed: Promise<void> | null = null;
  declare readonly [Symbol.asyncDispose]: () => Promise<void>;

  constructor(lease: TargetLease, opened: OpenedSegment, info: ContainerInfo, inflate: Inflate) {
    const source = withPendingReads(lease.source, this.#pending);
    const held = { ...opened, source };
    this.tracks = allTracks(opened);
    this.info = { ...info };
    this.#lease = lease;
    const closing = this.#closing.signal;
    this.#file = fileOf(held, info, inflate, closing);
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
      const refusal = refusalOf(error, signal);
      throw new RefusalError(refusal);
    } finally {
      unlink();
    }
  }

  readable(track: Track): boolean {
    const entry = entryOf(this.#file, track);
    return claimFor(entry, this.#file) !== null;
  }

  frames(tracks: readonly Track[], options: FrameOptions = {}): AsyncIterableIterator<Frame> {
    const entries = entriesOf(this.#file, tracks);
    const callerOptions = { ...options };
    const settled = settledFrameOptions(callerOptions, this.#lease.source.trip);
    return framesOf(this.#file, entries, settled, this.#closing.signal);
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
  try {
    const opened = await openSegment(lease.source, signal, inflate);
    if (typeof opened === "string") throw new RefusalError(opened);
    const info = await readInfo(opened, signal);
    return new LeasedContainer(lease, opened, info, inflate);
  } catch (error) {
    await lease.release?.();
    throw error;
  }
}

function withPendingReads(source: Source, pending: Set<Promise<unknown>>): Source {
  const read: Source["read"] = (...args) => {
    // Against its type, a source in JavaScript may answer the bytes rather than a promise of them.
    const reading = Promise.resolve(source.read(...args));
    pending.add(reading);
    const forget = () => pending.delete(reading);
    reading.then(forget, forget);
    return reading;
  };
  return { ...source, read };
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

function fileOf(
  opened: OpenedSegment,
  info: ContainerInfo,
  inflate: Inflate,
  closing: AbortSignal,
): FrameFile {
  const firstClusterTicks = sharedAndKept(
    (signal) => readFirstClusterTicks(opened, signal),
    closing,
  );
  const cues = sharedAndKept((signal) => readCues(opened, signal), closing);
  return { ...opened, info, inflate, firstClusterTicks, cues };
}

function entriesOf(file: FrameFile, tracks: readonly Track[]): TrackEntry[] {
  const chosen = new Set<TrackEntry>();
  for (const track of tracks) chosen.add(entryOf(file, track));
  return file.trackEntries.filter((entry) => chosen.has(entry));
}

function entryOf(file: FrameFile, track: Track): TrackEntry {
  const { index } = track;
  const entry = Number.isInteger(index) ? file.trackEntries[index] : undefined;
  if (entry !== undefined) {
    const own = trackOf(file, entry);
    if (statesTheSame(track, own)) return entry;
  }
  throw new TypeError(`track ${String(index)} is not a track of this file`);
}

function statesTheSame(given: unknown, own: unknown): boolean {
  if (typeof own !== "object" || own === null) return Object.is(given, own);
  if (own instanceof Uint8Array) return sameBytes(given, own);
  if (typeof given !== "object" || given === null) return false;
  if (Array.isArray(given) !== Array.isArray(own)) return false;
  const theirs = given as Record<string, unknown>;
  if (Array.isArray(own) && theirs.length !== own.length) return false;
  const ours = own as Record<string, unknown>;
  const keys = Object.keys(ours);
  const theirKeys = new Set(Object.keys(theirs));
  const sameKeys = keys.length === theirKeys.size && keys.every((key) => theirKeys.has(key));
  return sameKeys && keys.every((key) => statesTheSame(theirs[key], ours[key]));
}

function sameBytes(given: unknown, own: Uint8Array): boolean {
  if (!ArrayBuffer.isView(given)) return false;
  const items = given as Uint8Array;
  if (items.BYTES_PER_ELEMENT !== 1 || items.length !== own.length) return false;
  for (let at = 0; at < own.length; at++) {
    if (items[at] !== own[at]) return false;
  }
  return true;
}
