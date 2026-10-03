/**
 * The entry point that also takes file paths.
 *
 * The examples for URLs and bytes are in the browser entry's docs, under the same names.
 */

import type { Container, PeekOptions, PeekOutcome } from "../container/contract.js";
import { type Platform, peekWith } from "../container/listing.js";
import { openWith } from "../container/open.js";
import { type Target, urlRefusal } from "../container/target.js";
import { fileSource } from "../io/file.js";
import { inflateByZlib } from "../io/inflate-node.js";
import type { Source } from "../io/source.js";
import { isHttpUrl, namesAuthority } from "../io/url.js";
import { urlSource } from "../io/url-node.js";
import type { Abortable, RefusalCode } from "../vocabulary.js";

/**
 * Peeks at a container's track list.
 *
 * It reads only the header, and answers every type of track in one array.
 *
 * @example
 * const { tracks, info, attachments } = await peekTracks(path, {
 *   info: true,
 *   attachments: true,
 * });
 */
export function peekTracks(target: Target, options?: PeekOptions): Promise<PeekOutcome> {
  return peekWith(PLATFORM, target, options);
}

/**
 * Opens a container for its tracks' frames, and keeps the target open until `close`.
 *
 * It reads what `peekTracks` reads with `info`,
 * and throws a refusal at the open or at a read as a `RefusalError`.
 *
 * @example
 * const container = await openContainer(path);
 * try {
 *   const subtitles = container.tracks.filter((track) => track.type === "subtitle");
 *   for await (const frame of container.frames(subtitles)) console.log(frame.trackIndex, frame.data.length);
 * } finally {
 *   await container.close();
 * }
 */
export function openContainer(target: Target, options?: Abortable): Promise<Container> {
  return openWith(PLATFORM, target, options);
}

const PLATFORM: Platform = { open: viaPath, inflate: inflateByZlib };

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
