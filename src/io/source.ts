export interface SizedSource {
  source: Source;
  fileSize: number;
}

/** Anything addressable by offset and length can be a source. */
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
  /** Never called on a source handed in. Whoever opened a source closes it. */
  close?(): Promise<void>;
  /** A source that states none is read as `remote`. */
  trip?: Trip;
}

/**
 * What kind of round trip a read to this source is.
 *
 * - `local`: a disk on this machine.
 *
 * - `mount`: a network share read as files, such as SMB, NFS or SSHFS.
 *
 * - `remote`: a server across a network, such as one answering HTTP Range requests.
 */
export type Trip = "local" | "mount" | "remote";

export interface Range {
  at: number;
  length: number;
}

export interface IndexFetch {
  /** Two ranges closer than this are fetched as one, gap included. */
  readonly gapBytes: number;
  readonly concurrency: number;
}

export interface WalkFetch {
  /** How far past a block the walk reads ahead when it reads that block. */
  readonly blockAheadBytes: number;
  readonly concurrency: number;
}

/**
 * Undoes zlib's deflate into a buffer of its own.
 *
 * It rejects bytes past the stream's end, and a stream that inflates past `most` bytes, stopping there.
 */
export type Inflate = (deflated: Uint8Array, most: number) => Promise<Uint8Array>;

export const TRIPS: Readonly<Record<Trip, true>> = { local: true, mount: true, remote: true };

/** The opening read, wide enough for a typical header in one round trip. */
export const HEAD_BYTES = 128 * 1024;

/**
 * From this size a file Source stops zero-filling, and the pool makes no slot or loan below it.
 *
 * On a large read the zero-fill costs as much as the read.
 */
export const LARGE_READ_BYTES = 16 * 1024;

export const lend = (into: Uint8Array | undefined, bounded: number): Uint8Array | null =>
  into !== undefined && into.length >= bounded ? into.subarray(0, bounded) : null;

export function available(at: number, length: number, size: number): number {
  const addressable = Number.isInteger(at) && at >= 0 && Number.isInteger(length) && length >= 0;
  if (!addressable) {
    throw new RangeError(`a read asked for ${String(length)} bytes at ${String(at)}`);
  }
  return Math.max(0, Math.min(length, size - at));
}
