/**
 * The entry point that also takes file paths.
 *
 * The examples for URLs and bytes are in the browser entry's docs, under the same names.
 */

import type { Container, Listing } from "../container/contract.js";
import { openWith, type Platform, peekWith } from "../container/open.js";
import type { Target } from "../container/target.js";
import { isHttpUrl, namesAuthority } from "../io/http.js";
import type { Source } from "../io/source.js";
import type { Abortable, RefusalCode } from "../vocabulary.js";
import { fileSource } from "./file.js";
import { urlSource } from "./http.js";
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
  if (namesAuthority(target)) return "invalid-target";
  try {
    return await fileSource(target);
  } catch (error) {
    const parsed = URL.parse(target);
    const intendedAsUrl =
      parsed !== null &&
      (parsed.protocol === "file:" || parsed.search !== "" || parsed.hash !== "");
    if (intendedAsUrl) return "invalid-target";
    throw error;
  }
}
