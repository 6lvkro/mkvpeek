/**
 * Anything addressable by offset and length can be a source.
 *
 * - a file
 * - an HTTP server that honours Range requests
 * - an object store
 * - a buffer already in memory
 */
export interface Source {
  /**
   * The length in bytes.
   *
   * @param signal The signal of the read that asks, for a source that has to fetch to know.
   */
  size(signal?: AbortSignal): Promise<number>;
  /**
   * Returns as much as was asked for.
   *
   * A short answer anywhere but at the end of the file is read as the source having stopped.
   *
   * @param into A buffer the source may write into and return a subarray of, or ignore;
   * the returned view is what counts. It must not be touched once the read resolves.
   *
   * @param signal The signal of the read that asks, for a source that can cut a read in flight.
   */
  read(at: number, length: number, into?: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>;
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

/**
 * Undoes zlib's deflate into a buffer of its own.
 *
 * It rejects bytes past the stream's end, and a stream that inflates past `most` bytes, which it stops inflating there.
 */
export type Inflate = (deflated: Uint8Array, most: number) => Promise<Uint8Array>;

export interface Watch {
  onProgress: ReportBytes;
  signal: AbortSignal;
}

type ReportBytes = (done: number, total: number) => void;

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

/** The most a stored stream is undone to however much it stored, where ffmpeg stops growing a frame's buffer. */
export const MAX_INFLATED_BYTES = 10_000_000;

/**
 * Lends the front of the hint when it can hold the clamped answer.
 *
 * Otherwise null, and the caller allocates.
 */
export const lend = (into: Uint8Array | undefined, bounded: number): Uint8Array | null =>
  into !== undefined && into.length >= bounded ? into.subarray(0, bounded) : null;

export const givenSignal = (signal: AbortSignal | null | undefined): AbortSignal | undefined =>
  signal ?? undefined;

export function abortReason(signal: AbortSignal | undefined): Error | null {
  if (signal?.aborted !== true) return null;
  const { reason: cause } = signal;
  try {
    return cause instanceof Error ? cause : new Error(String(cause));
  } catch {
    return new Error("aborted", { cause });
  }
}

export function stopIfAborted(signal: AbortSignal | undefined): void {
  const stopped = abortReason(signal);
  if (stopped !== null) throw stopped;
}

/** A Watch whose report cannot end the read by throwing, and is not made once the signal fires. */
export function watchOver(signal: AbortSignal, report: ReportBytes): Watch {
  const onProgress: ReportBytes = (done, total) => {
    if (signal.aborted) return;
    let returned: unknown;
    try {
      returned = report(done, total);
    } catch {}
    if (returned instanceof Promise) returned.catch(() => {});
  };
  return { onProgress, signal };
}

export function available(at: number, length: number, size: number): number {
  const addressable = Number.isInteger(at) && at >= 0 && Number.isInteger(length) && length >= 0;
  if (!addressable) {
    throw new RangeError(`a read asked for ${String(length)} bytes at ${String(at)}`);
  }
  return Math.max(0, Math.min(length, size - at));
}

/** A signal that fires when either does, and the call that stops it listening to them. */
export function linkedSignal(
  outer: AbortSignal | undefined,
  inner: AbortSignal,
): { signal: AbortSignal; unlink: () => void } {
  const linked = new AbortController();
  const unlink = forwardAbort([outer, inner], linked);
  return { signal: linked.signal, unlink };
}

/**
 * Aborts `into` with the reason of the first of the signals to fire, and from then listens to none.
 *
 * The call it answers stops the listening sooner.
 */
export function forwardAbort(
  signals: ReadonlyArray<AbortSignal | undefined>,
  into: AbortController,
): () => void {
  const unhooks: Array<() => void> = [];
  const unlink = () => {
    for (const unhook of unhooks.splice(0)) unhook();
  };
  for (const signal of signals) {
    if (signal === undefined) continue;
    const fired = () => {
      unlink();
      into.abort(signal.reason);
    };
    unhooks.push(onAbort(signal, fired));
    if (into.signal.aborted) break;
  }
  return unlink;
}

/** The answer, or a rejection with the signal's reason where the signal fires first. */
export function untilAborted<T>(answer: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const unhook = onAbort(signal, () => reject(abortReason(signal)));
    answer.then(
      (value) => {
        unhook();
        resolve(value);
      },
      (error: unknown) => {
        unhook();
        reject(error);
      },
    );
  });
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
