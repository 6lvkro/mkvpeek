import type { Abortable } from "../vocabulary.js";

/** Its times are on the file's timeline, in milliseconds that are not rounded. */
export interface Frame {
  /** The track's `index`, not its TrackNumber. */
  trackIndex: number;
  startMs: number;
  /** null when the block states none, as an image subtitle's blocks do. */
  durationMs: number | null;
  /** What the track stored, with its ContentEncodings undone, in a buffer of its own. */
  data: Uint8Array;
}

/** What a caller can say about the cost of a read. */
export interface FrameTuning {
  preset?: FramePreset;
  /**
   * Concurrent range requests on the index path, and lanes on the walk.
   *
   * An integer of at least 1, or the call throws a RangeError, and past 64 it is read as 64.
   *
   * WARN: on a network path this is the number of open connections,
   * so **mind the target server's socket limit.**
   */
  concurrency?: number;
}

/**
 * - `balanced`: (default) the knee of the time-transfer curve
 *
 * - `fastest`: minimises time.
 *
 * - `leanest`: minimises transfer.
 */
export type FramePreset = "balanced" | "fastest" | "leanest";

export type FrameFinder = "index" | "walk";

/**
 * The policy for finding a track's frames.
 *
 * - `index`: follows the container's Cues and picks up only the frames.
 * Fast, but a muxer may have written no index, so it accepts fewer containers than `walk`.
 *
 * - `walk`: visits every cluster. Slow, reading block by block, but it answers without an index.
 *
 * - `both`: (default) `index` first, then `walk` wherever the index refused.
 */
export type FrameVia = "both" | FrameFinder;

/**
 * The options are read once, when `frames` is called.
 *
 * An unknown `via` or `preset`, or a `strict` that is not a boolean, throws a TypeError there.
 */
export interface FrameOptions extends FrameTuning, Abortable {
  via?: FrameVia;
  /**
   * Reads by the index only a track that states its frame count,
   * and dates every frame by its cluster's own timestamp rather than its cue's.
   *
   * A track it cannot prove whole goes to the walk under `both`, and is refused under `index`.
   */
  strict?: boolean;
  /**
   * @example
   * await using container = await openContainer(path);
   * const subtitles = container.tracks.filter((track) => track.type === "subtitle");
   * const reading = container.frames(subtitles, {
   *   onProgress: ({ doneBytes, totalBytes, finder }) => bar.set(finder, doneBytes / totalBytes),
   * });
   * for await (const frame of reading) console.log(frame.startMs);
   *
   * @example
   * // A budget, aborting past a per-path cap
   * const stop = new AbortController();
   * const most = { index: 100 * 1024 ** 2, walk: 1024 ** 3 };
   * await using container = await openContainer(path);
   * const subtitles = container.tracks.filter((track) => track.type === "subtitle");
   * const reading = container.frames(subtitles, {
   *   signal: stop.signal,
   *   onProgress: (p) => { if (p.totalBytes > most[p.finder]) stop.abort(); },
   * });
   */
  onProgress?: (progress: FrameProgress) => void;
}

/** Told first with the price, before any frame's bytes are fetched, and then as the read goes. */
export interface FrameProgress {
  /**
   * The path doing the reading.
   *
   * Under {@linkcode FrameVia} `both`, a `walk` here means `index` backed off.
   */
  finder: FrameFinder;
  /** Grows toward `totalBytes`, and never goes back. */
  doneBytes: number;
  /**
   * - `index`: the bytes the plan means to fetch, raised by what the read fetches past it
   *
   * - `walk`: the file size
   */
  totalBytes: number;
}
