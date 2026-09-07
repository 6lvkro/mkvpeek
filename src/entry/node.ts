/**
 * The entry point that also takes file paths.
 *
 * The browser bundle takes only URLs and bytes, on a surface of the same names.
 */

import { fileSource } from "../io/file.js";
import { isHttpUrl, namesAuthority } from "../io/url.js";
import { urlSource } from "../io/url-node.js";
import type { PeekOptions, PeekOutcome } from "../peek/contract.js";
import { peekTracksFrom } from "../peek/engine.js";
import { type Opener, overTarget, type Target, urlRefusal } from "../peek/target.js";
import type { SubtitleOptions } from "../subtitle/options.js";
import { peekSubtitlesFrom } from "../subtitle/peek.js";
import type { ListedTrack } from "../tracks/list.js";
import type { SubtitleTrack } from "../tracks/subtitle.js";

/**
 * Peeks at a container's subtitles.
 *
 * For examples beyond file paths, see the same name in `mkvpeek/browser`.
 *
 * @example
 * const { code, tracks } = await peekSubtitles(path);
 *
 * @example
 * // The list alone, one read of the head and no bodies. Bodies cost the index or a walk.
 * const { code, tracks } = await peekSubtitles(path, { text: false });
 */
export function peekSubtitles(
  target: Target,
  options: SubtitleOptions = {},
): Promise<PeekOutcome<SubtitleTrack>> {
  return overTarget(target, options, peekSubtitlesFrom, viaPath);
}

/**
 * Peeks at a container's track list
 *
 * Track-level facts only, every kind flat in one array.
 *
 * For examples beyond file paths, see the same name in `mkvpeek/browser`.
 *
 * @example
 * const { tracks, info, attachments } = await peekTracks(path, {
 *   info: true,
 *   attachments: true,
 * });
 */
export function peekTracks(
  target: Target,
  options: PeekOptions = {},
): Promise<PeekOutcome<ListedTrack>> {
  return overTarget(target, options, peekTracksFrom, viaPath);
}

const viaPath: Opener = async (target, signal) => {
  if (isHttpUrl(target)) return urlSource(target, { signal });
  if (namesAuthority(target)) {
    const parsed = URL.parse(target);
    if (parsed !== null) {
      const refusal = urlRefusal(parsed);
      if (refusal !== null) return refusal;
    }
  }
  try {
    return await fileSource(target);
  } catch (error) {
    const parsed = URL.parse(target);
    const intendedAsUrl =
      parsed !== null &&
      (parsed.protocol === "file:" || parsed.search !== "" || parsed.hash !== "");
    if (intendedAsUrl) {
      const refusal = urlRefusal(parsed);
      if (refusal !== null) return refusal;
    }
    throw error;
  }
};
