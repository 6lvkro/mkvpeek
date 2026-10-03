/**
 * The flags whose structure the spec dictates.
 *
 * enabled, default and forced are effective values with the spec defaults (1, 1, 0) applied;
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
  durationMs: number | null;
  timestampScale: number;
}

export interface Attachment {
  fileName: string | null;
  mimeType: string | null;
  description: string | null;
  at: number | null;
  size: number;
  uid: string | null;
}

export interface TrackTag {
  name: string;
  value: string;
}

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
 */
export type RefusalCode =
  | "not-matroska"
  | "malformed"
  | "unreadable"
  | "source-failed"
  | "invalid-target"
  | "cancelled";

/**
 * Completion is the one code `served`.
 *
 * The refusal side can grow,
 * so a branch on codes should leave room for a code that does not exist yet.
 */
export type PeekCode = "served" | RefusalCode;

export interface Abortable {
  /**
   * Stops this call alone, which then ends `cancelled` and reports nothing after.
   *
   * @example
   * const stop = new AbortController();
   * const patience = setTimeout(() => stop.abort(), 5_000);
   * await peekTracks(url, { signal: stop.signal }).finally(() => clearTimeout(patience));
   */
  signal?: AbortSignal;
}

/** A refusal an open, a read of frames or `attachments` throws, carrying the code `peekTracks` answers with. */
export class RefusalError extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode) {
    super(code);
    this.name = "RefusalError";
    this.code = code;
  }
}

/**
 * Whether the outcome is a refusal rather than a serve.
 *
 * @example
 * const { code } = await peekTracks(path);
 * if (isRefusalCode(code)) throw new Error(code);
 */
export const isRefusalCode = (code: PeekCode): code is RefusalCode => Object.hasOwn(REFUSALS, code);

/**
 * Whether a file this reader refused is worth handing to another tool, ffmpeg say.
 *
 * Yes for a refusal that read the container; no where the bytes did not arrive or the call was wrong.
 *
 * @example
 * const { code, tracks } = await peekTracks(path);
 * if (!isRefusalCode(code)) return tracks;
 * if (worthFallback(code)) return demux(path);
 * throw new Error(code);
 */
export const worthFallback = (code: PeekCode): boolean =>
  isRefusalCode(code) && REFUSALS[code].worthFallback;

const REFUSALS = {
  "not-matroska": { worthFallback: true },
  malformed: { worthFallback: true },
  unreadable: { worthFallback: true },
  "source-failed": { worthFallback: false },
  "invalid-target": { worthFallback: false },
  cancelled: { worthFallback: false },
} as const satisfies Record<RefusalCode, { worthFallback: boolean }>;
