/**
 * The entry point that also takes file paths.
 *
 * The examples for URLs and bytes are in the browser entry's docs, under the same names.
 */

import type { Container, Listing } from "../container/contract.js";
import { openWith, type Platform, peekWith } from "../container/open.js";
import type { Target } from "../container/target.js";
import { isHttpUrl, namesAuthority, urlSource } from "../io/http.js";
import type { Source } from "../io/source.js";
import { type Abortable, RefusalError } from "../vocabulary.js";
import { fileSource } from "./file.js";
import { inflateByZlib } from "./inflate.js";

/**
 * Peeks at a container's track list.
 *
 * It reads only the header, answers every type of track in one array,
 * and throws a refusal as a `RefusalError`, as `openContainer` does.
 *
 * @example
 * const { tracks, info } = await peekTracks(path);
 */
export function peekTracks(target: Target, options?: Abortable): Promise<Listing> {
  return peekWith(PLATFORM, target, options);
}

/**
 * Opens a container for its tracks' frames, and keeps the target open until `close`.
 *
 * It reads what `peekTracks` reads, and throws a refusal at the open or at a read as a `RefusalError`.
 *
 * @example
 * await using container = await openContainer(path);
 * const subtitles = container.tracks.filter((track) => track.type === "subtitle");
 * for await (const frame of container.frames(subtitles)) console.log(frame.trackIndex, frame.data.length);
 */
export function openContainer(target: Target, options?: Abortable): Promise<Container> {
  return openWith(PLATFORM, target, options);
}

const PLATFORM: Platform = { open: viaPath, inflate: inflateByZlib };

/** Opens a string target as a path, or as a URL where it names one. */
async function viaPath(target: string): Promise<Source> {
  if (isHttpUrl(target)) return urlSource(target);
  if (namesAuthority(target)) throw new RefusalError("invalid-target");
  try {
    return await fileSource(target);
  } catch (cause) {
    const parsed = URL.parse(target);
    const intendedAsUrl =
      parsed !== null &&
      (parsed.protocol === "file:" || parsed.search !== "" || parsed.hash !== "");
    if (intendedAsUrl) throw new RefusalError("invalid-target");
    throw new RefusalError("source-failed", { cause });
  }
}
