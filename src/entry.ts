import type { Container, PeekOptions, PeekOutcome } from "./container/contract.js";
import { type Platform, peekWith } from "./container/listing.js";
import { openWith } from "./container/open.js";
import { type Target, viaUrl } from "./container/target.js";
import { inflateByStream } from "./io/inflate.js";
import type { Abortable } from "./vocabulary.js";

/**
 * Peeks at a container's track list.
 *
 * It reads only the header, and answers every type of track in one array.
 *
 * @example
 * // A URL, when the server allows Range requests
 * const { tracks } = await peekTracks(url);
 * const dubbed = tracks.filter((t) => t.type === "audio" && t.language !== null);
 *
 * @example
 * // Bytes already in memory (an upload body, a queue message)
 * const { code, tracks } = await peekTracks(bytes);
 *
 * @example
 * // Options the package cannot predefine: open the source yourself, and close what you opened.
 * const source = await urlSource(url, { headers });
 * try {
 *   const { code, tracks } = await peekTracks(source);
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
 * const { code, tracks } = await peekTracks(source);
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
 * try {
 *   const container = await openContainer(url);
 *   try {
 *     const subtitles = container.tracks.filter((track) => track.type === "subtitle");
 *     for await (const frame of container.frames(subtitles)) console.log(frame.trackIndex, frame.startMs);
 *   } finally {
 *     await container.close();
 *   }
 * } catch (error) {
 *   if (!(error instanceof RefusalError)) throw error;
 *   if (worthFallback(error.code)) await demux(url);
 * }
 */
export function openContainer(target: Target, options?: Abortable): Promise<Container> {
  return openWith(PLATFORM, target, options);
}

const PLATFORM: Platform = { open: viaUrl, inflate: inflateByStream };
