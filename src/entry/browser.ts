import type { PeekOptions, PeekOutcome } from "../peek/contract.js";
import { peekTracksFrom } from "../peek/engine.js";
import { overTarget, type Target } from "../peek/target.js";
import type { SubtitleOptions } from "../subtitle/options.js";
import { peekSubtitlesFrom } from "../subtitle/peek.js";
import type { ListedTrack } from "../tracks/list.js";
import type { SubtitleTrack } from "../tracks/subtitle.js";

/**
 * Peeks at a container's subtitles.
 *
 * @example
 * // Bytes already in memory (an upload body, a queue message)
 * const { code, tracks } = await peekSubtitles(bytes);
 *
 * @example
 * // A URL, when the server allows Range requests
 * const { code, tracks } = await peekSubtitles(url);
 *
 * @example
 * // Options the package cannot predefine: open the source yourself, and close what you opened.
 * const source = await urlSource(url, { headers });
 * try {
 *   const { code, tracks } = await peekSubtitles(source);
 * } finally {
 *   await source.close?.();
 * }
 *
 * @example
 * // Without loading an uploaded File into memory
 * const source: Source = {
 *   size: () => Promise.resolve(file.size),
 *   read: async (at, n) => new Uint8Array(await file.slice(at, at + n).arrayBuffer()),
 * };
 * const { code, tracks } = await peekSubtitles(source);
 */
export function peekSubtitles(
  target: Target,
  options: SubtitleOptions = {},
): Promise<PeekOutcome<SubtitleTrack>> {
  return overTarget(target, options, peekSubtitlesFrom);
}

/**
 * Peeks at a container's track list
 *
 * Track-level facts only, every kind flat in one array.
 *
 * @example
 * const { tracks } = await peekTracks(url);
 * const dubbed = tracks.filter((t) => t.type === "audio" && t.language !== null);
 */
export function peekTracks(
  target: Target,
  options: PeekOptions = {},
): Promise<PeekOutcome<ListedTrack>> {
  return overTarget(target, options, peekTracksFrom);
}
