/**
 * The entry point that also takes file paths.
 *
 * The browser bundle takes only URLs and bytes, on a surface of the same names.
 */

import type { PeekOptions, PeekOutcome } from "../container/contract.js";
import { type Platform, peekTracksFrom, peekWith } from "../container/listing.js";
import { type Target, urlRefusal } from "../container/target.js";
import { fileSource } from "../io/file.js";
import type { Source } from "../io/source.js";
import { isHttpUrl, namesAuthority } from "../io/url.js";
import { urlSource } from "../io/url-node.js";
import type { SubtitleOptions } from "../subtitle/options.js";
import { peekSubtitlesFrom } from "../subtitle/peek.js";
import type { ListedTrack } from "../tracks/list.js";
import type { SubtitleTrack } from "../tracks/subtitle.js";
import type { RefusalCode } from "../vocabulary.js";

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
  return peekWith(PLATFORM, target, options, peekSubtitlesFrom);
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
  return peekWith(PLATFORM, target, options, peekTracksFrom);
}

const PLATFORM: Platform = { open: viaPath };

/** Opens a string target as a path, or as a URL where it names one. */
async function viaPath(target: string): Promise<Source | RefusalCode> {
  if (isHttpUrl(target)) return urlSource(target);
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
}
