/**
 * Anything addressable by offset and length can be a source.
 *
 * - a file
 * - an HTTP server that honours Range requests
 * - an object store
 * - a buffer already in memory
 */
export interface Source {
  size(): Promise<number>;
  /**
   * Returns as much as was asked for.
   *
   * A short answer anywhere but at the end of the file is read as the source having stopped.
   *
   * @param into A reuse hint.
   * A cooperating source writes there and returns that subarray, and may ignore it;
   * either way the returned view is the truth.
   * Touching it again after resolve breaks the contract,
   * and a late write changes the bytes of whoever holds the borrowed window.
   */
  read(at: number, length: number, into?: Uint8Array): Promise<Uint8Array>;
  close?(): Promise<void>;
  trip?: Trip;
}

/** What kind of round trip a read to this source is. */
export type Trip = "local" | "mount" | "remote";

/** A source whose size has been asked. */
export interface SizedSource {
  source: Source;
  fileSize: number;
}

export interface Range {
  at: number;
  length: number;
}

/** The index path's knobs, the shape of a planned read of scattered ranges. */
export interface IndexFetch {
  /**
   * Two ranges closer than this are fetched as one, gap included.
   *
   * Raising it trades bytes for round trips; at 0 only ranges that already touch are merged.
   */
  gapBytes: number;
  /**
   * How far past its stated size to look at each point the plan names.
   *
   * Raising it makes more points finish in one read at the cost of bytes,
   * and a window this wide sits on the heap per point.
   */
  cueAheadBytes: number;
  /**
   * Concurrent range requests.
   *
   * WARN: on a network path this is the number of open connections,
   * so **mind the target server's socket limit.**
   */
  concurrency: number;
}

/** The walk path's knobs, the shape of a scan that starts at the front. */
export interface WalkFetch {
  /**
   * How far past a block the walk reads ahead when it reads that block.
   *
   * Raising it trades bytes for round trips; at 0 it reads only what was asked for.
   */
  blockAheadBytes: number;
  /**
   * Walk lanes.
   *
   * On a network path it means the same as {@linkcode IndexFetch.concurrency}.
   */
  concurrency: number;
}

export type ReportBytes = (done: number, total: number) => void;

export interface Watch {
  onProgress: ReportBytes;
  signal: AbortSignal | undefined;
}

/**
 * How much the opening read fetches.
 *
 * A number that usually finishes a typical header in one round trip.
 */
export const HEAD_BYTES = 128 * 1024;

/**
 * From this size a file Source stops zero-filling, and the pool makes no slot or loan below it.
 *
 * On a large read the zero-fill costs as much as the read.
 */
export const LARGE_READ_BYTES = 16 * 1024;

export const MAX_SPAN_BYTES = 4 * 1024 ** 2;

/**
 * Lends the front of the hint when it can hold the clamped answer.
 *
 * Otherwise null, and the caller allocates.
 */
export const lend = (into: Uint8Array | undefined, bounded: number): Uint8Array | null =>
  into !== undefined && into.length >= bounded ? into.subarray(0, bounded) : null;

export function abortReason(signal: AbortSignal | undefined): Error | null {
  if (signal?.aborted !== true) return null;
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
}

export function stopIfAborted(signal: AbortSignal | undefined): void {
  const stopped = abortReason(signal);
  if (stopped !== null) throw stopped;
}

export function available(at: number, length: number, size: number): number {
  const addressable = Number.isInteger(at) && at >= 0 && Number.isInteger(length) && length >= 0;
  if (!addressable) {
    throw new RangeError(`a read asked for ${String(length)} bytes at ${String(at)}`);
  }
  return Math.max(0, Math.min(length, size - at));
}

export function onAbort(signal: AbortSignal | undefined, run: () => void): () => void {
  if (signal === undefined) return () => {};
  if (signal.aborted) {
    run();
    return () => {};
  }
  signal.addEventListener("abort", run, { once: true });
  return () => signal.removeEventListener("abort", run);
}
