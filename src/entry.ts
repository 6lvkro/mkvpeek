import type { Container, Listing } from "./container/contract.js";
import { openWith, type Platform, peekWith } from "./container/open.js";
import { type Target, viaUrl } from "./container/target.js";
import { inflateByStream } from "./io/inflate.js";
import type { Abortable } from "./vocabulary.js";

/**
 * Peeks at a container's track list.
 *
 * It reads only the header, answers every type of track in one array,
 * and throws a refusal as a `RefusalError`, as `openContainer` does.
 *
 * @example
 * // A URL, when the server allows Range requests
 * const { tracks } = await peekTracks(url);
 * const dubbed = tracks.filter((t) => t.type === "audio" && t.language !== null);
 *
 * @example
 * // Bytes already in memory (an upload body, a queue message)
 * const { tracks } = await peekTracks(bytes);
 *
 * @example
 * // Options the package cannot predefine: open the source yourself, and close what you opened.
 * await using source = await urlSource(url, { headers });
 * const { tracks } = await peekTracks(source);
 *
 * @example
 * // Without loading an uploaded File into memory
 * const { tracks } = await peekTracks(blobSource(file));
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
 * await using container = await openContainer(url);
 * const subtitles = container.tracks.filter((track) => track.type === "subtitle");
 * for await (const frame of container.frames(subtitles)) console.log(frame.trackIndex, frame.startMs);
 */
export function openContainer(target: Target, options?: Abortable): Promise<Container> {
  return openWith(PLATFORM, target, options);
}

const PLATFORM: Platform = { open: viaUrl, inflate: inflateByStream };
