import type { Container } from "../container/contract.js";
import type { Frame, FrameOptions } from "../frames/contract.js";
import type { Track } from "../tracks.js";
import { assemble } from "./assemble.js";
import type { SubtitleFile } from "./contract.js";

/**
 * Writes an ASS, SSA, SubRip or WebVTT track out as a file, from frames that may hold other tracks' too.
 *
 * Any other track answers null:
 * an image track such as PGS or VobSub, a codec it does not know, or a SubStation track whose `codecPrivate` is null.
 *
 * @example
 * const frames = await Array.fromAsync(container.frames([track]));
 * const sub = subtitleFile(track, frames);
 * if (sub !== null) await writeFile(`${name}.${sub.format}`, sub.text);
 */
export function subtitleFile(track: Track, frames: readonly Frame[]): SubtitleFile | null {
  const own = frames.filter((frame) => frame.trackIndex === track.index && frame.data.length > 0);
  return assemble(track, own);
}

/**
 * Writes out every track of `container.tracks` that `subtitleFile` writes and `readable` answers true for.
 *
 * It writes nothing where that read is refused.
 *
 * @example
 * for (const { track, format, text } of await subtitleFiles(container)) {
 *   await writeFile(`${track.index}.${format}`, text);
 * }
 */
export async function subtitleFiles(
  container: Container,
  options: FrameOptions = {},
): Promise<SubtitleFile[]> {
  const written = container.tracks.filter(
    (track) => subtitleFile(track, []) !== null && container.readable(track),
  );
  const frames: Frame[] = [];
  for await (const frame of container.frames(written, options)) frames.push(frame);
  return written.map((track) => subtitleFile(track, frames) as SubtitleFile);
}
