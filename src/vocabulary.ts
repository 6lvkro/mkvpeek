/**
 * `enabled`, `default` and `forced` are effective values with the spec defaults (1, 1, 0) applied;
 * the other five have no default.
 */
export interface TrackFlags {
  enabled: boolean;
  default: boolean;
  forced: boolean;
  hearingImpaired: boolean | null;
  visualImpaired: boolean | null;
  textDescriptions: boolean | null;
  original: boolean | null;
  commentary: boolean | null;
}

export interface ContainerInfo {
  title: string | null;
  muxingApp: string | null;
  writingApp: string | null;
  /** null where the container states none. */
  durationMs: number | null;
  /** Nanoseconds per tick, 1,000,000 where the container states none. */
  timestampScale: number;
}

/** What an attached file states of itself, its bytes left unread. */
export interface Attachment {
  fileName: string | null;
  mimeType: string | null;
  description: string | null;
  /** Where the file's bytes start in the container, for a read of `size` bytes; null where it holds none. */
  at: number | null;
  size: number;
  /** The FileUID in hexadecimal, as `Track.uid` is spelt. */
  uid: string | null;
}

export interface TrackTag {
  name: string;
  value: string;
}

/** A `Uint8Array` over an `ArrayBuffer` of its own. */
export type Bytes = ReturnType<Uint8Array["slice"]>;

/**
 * The reasons a requested read could not be completed.
 *
 * - `not-matroska`: there is no EBML header.
 *
 * - `malformed`: the container does not conform.
 *
 * - `unreadable`: the container conforms, but this reader's path could not do it.
 *
 * - `source-failed`: the bytes did not arrive; retry, or check the transport.
 *
 * - `invalid-target`: the input itself cannot be opened; fix the call.
 *
 * - `cancelled`: the caller's signal fired, or the container was closed.
 *
 * The list can grow, so a branch on codes should leave room for one that does not exist yet.
 */
export type RefusalCode =
  | "not-matroska"
  | "malformed"
  | "unreadable"
  | "source-failed"
  | "invalid-target"
  | "cancelled";

export interface Abortable {
  /**
   * Stops this call alone before its next read, frame or progress report, and it then ends `cancelled`.
   *
   * @example
   * const stop = new AbortController();
   * const patience = setTimeout(() => stop.abort(), 5_000);
   * await peekTracks(url, { signal: stop.signal }).finally(() => clearTimeout(patience));
   */
  signal?: AbortSignal;
}

/**
 * A refusal a peek, an open, a read of frames or `attachments` throws.
 *
 * Under `source-failed`, its `cause` is what the source threw.
 */
export class RefusalError extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = "RefusalError";
    this.code = code;
  }
}

/**
 * Whether the file behind a `RefusalError`, or its `code`, is worth handing to another tool, ffmpeg say.
 *
 * Yes for a refusal that read the container;
 * no for one where the bytes did not arrive or the call was wrong, and for anything else.
 *
 * @example
 * try {
 *   return (await peekTracks(path)).tracks;
 * } catch (error) {
 *   if (worthFallback(error)) return demux(path);
 *   throw error;
 * }
 */
export function worthFallback(refusal: unknown): boolean {
  if (refusal instanceof RefusalError) return worthFallback(refusal.code);
  return Object.entries(WORTH_FALLBACK).some(([code, worth]) => worth && code === refusal);
}

const WORTH_FALLBACK: Readonly<Record<RefusalCode, boolean>> = {
  "not-matroska": true,
  malformed: true,
  unreadable: true,
  "source-failed": false,
  "invalid-target": false,
  cancelled: false,
};
