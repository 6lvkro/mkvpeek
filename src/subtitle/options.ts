import type { IndexFetch, WalkFetch } from "../io/source.js";
import type { PeekOptions } from "../peek/contract.js";
import type { SubtitleFinder } from "../vocabulary.js";

export type FetchKnobs = IndexFetch & WalkFetch;

/** What a caller can say about the cost of a read. */
export interface SubtitleTuning {
  preset?: SubtitlePreset;
  overrides?: Partial<FetchKnobs>;
}

/**
 * - `balanced`: (default) the knee of the time-transfer curve
 *
 * - `fastest`: minimises time.
 *
 * - `leanest`: minimises transfer.
 */
export type SubtitlePreset = "balanced" | "fastest" | "leanest";

/**
 * The policy for finding a subtitle track's frames.
 *
 * - `index`: follows the container's Cues and picks up only the frames.
 * Fast, but a muxer may have written no index, so it accepts fewer containers than `walk`.
 *
 * - `walk`: visits every cluster. Slow, reading block by block, but it answers without an index.
 *
 * - `both`: (default) `index` first,
 *   falling back to `walk` only when what made it back off was the index or the source.
 *   When the container is at fault `walk` would do the same, so it ends.
 */
export type SubtitleVia = "both" | SubtitleFinder;

/** The options of `peekSubtitles`. */
export interface SubtitleOptions extends PeekOptions, SubtitleTuning {
  /**
   * An explicit `false` reads the header alone and returns early with no bodies.
   *
   * The finding half ({@linkcode via}, the tuning, {@linkcode onProgress}) is ignored then.
   */
  text?: boolean;
  via?: SubtitleVia;
  /**
   * @example
   * await peekSubtitles(path, {
   *   onProgress: ({ done, total, finder }) => bar.set(finder, done / total),
   * });
   *
   * @example
   * // A budget, aborting past a per-path cap
   * const stop = new AbortController();
   * const most = { index: 100 * 1024 ** 2, walk: 1024 ** 3 };
   * await peekSubtitles(path, {
   *   via: "both",
   *   signal: stop.signal,
   *   onProgress: (p) => { if (p.total > most[p.finder]) stop.abort(); },
   * });
   */
  onProgress?: (progress: SubtitleProgress) => void;
}

/**
 * One progress report, which {@linkcode SubtitleOptions.onProgress} receives.
 */
export interface SubtitleProgress {
  /**
   * The path doing the reading.
   *
   * Under {@linkcode SubtitleVia} `both`, a `walk` here means `index` backed off.
   */
  finder: SubtitleFinder;
  doneBytes: number;
  /**
   * - `index`: the bytes the plan means to fetch
   *
   * - `walk`: the file size
   */
  totalBytes: number;
}

export const DEFAULT_VIA: SubtitleVia = "both";
