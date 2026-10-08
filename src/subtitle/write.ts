import type { Container } from "../container/contract.js";
import type { Frame, FrameOptions } from "../frames/contract.js";
import type { Track } from "../tracks.js";
import type { SubtitleFile, SubtitleFormat } from "./contract.js";
import { assembleSrt } from "./srt.js";
import { assembleSubstation, substationScript } from "./substation.js";
import { assembleSup } from "./sup.js";
import { assembleVtt } from "./vtt.js";

export interface SubtitleOptions extends FrameOptions {
  /**
   * The formats written out, the text ones unless named.
   *
   * An unknown one is a TypeError.
   */
  formats?: readonly SubtitleFormat[];
}

/**
 * The format `subtitleFile` writes a track in: ASS, SSA, SubRip, WebVTT, or a PGS track's .sup.
 *
 * Null for any other track:
 * VobSub, a codec it does not know, or a SubStation track whose `codecPrivate` is null.
 */
export function subtitleFormat(track: Track): SubtitleFormat | null {
  return writerOf(track)?.format ?? null;
}

/**
 * Writes a track out as a file, from frames that may hold other tracks' too.
 *
 * It answers null where `subtitleFormat` does.
 *
 * @example
 * const frames = await Array.fromAsync(container.frames([track]));
 * const sub = subtitleFile(track, frames);
 * if (sub !== null) await writeFile(`${name}.${sub.format}`, sub.bytes);
 */
export function subtitleFile(track: Track, frames: readonly Frame[]): SubtitleFile | null {
  const writer = writerOf(track);
  if (writer === null) return null;
  const own = frames.filter((frame) => frame.trackIndex === track.index && frame.data.length > 0);
  return { track, format: writer.format, bytes: writer.write(own) };
}

/**
 * Writes out every track of `container.tracks` whose format `formats` names and that `readable` answers true for.
 *
 * It writes nothing where that read is refused.
 *
 * @example
 * for (const { track, format, bytes } of await subtitleFiles(container)) {
 *   await writeFile(`${track.index}.${format}`, bytes);
 * }
 */
export async function subtitleFiles(
  container: Container,
  options: SubtitleOptions = {},
): Promise<SubtitleFile[]> {
  const formats: ReadonlySet<SubtitleFormat | null> = formatsNamed({ ...options }.formats);
  const written = container.tracks.filter(
    (track) => formats.has(subtitleFormat(track)) && container.readable(track),
  );
  const frames: Frame[] = [];
  for await (const frame of container.frames(written, options)) frames.push(frame);
  return written.map((track) => subtitleFile(track, frames) as SubtitleFile);
}

interface Writer {
  format: SubtitleFormat;
  write: (frames: readonly Frame[]) => Uint8Array;
}

const TEXT_FORMATS: ReadonlySet<SubtitleFormat> = new Set<SubtitleFormat>([
  "ass",
  "ssa",
  "srt",
  "vtt",
]);

const FORMATS: ReadonlySet<SubtitleFormat> = new Set<SubtitleFormat>([...TEXT_FORMATS, "sup"]);

function formatsNamed(formats: readonly SubtitleFormat[] | undefined): ReadonlySet<SubtitleFormat> {
  const named = new Set(formats ?? TEXT_FORMATS);
  for (const format of named) {
    if (!FORMATS.has(format)) throw new TypeError(`unknown format ${String(format)}`);
  }
  return named;
}

function writerOf(track: Track): Writer | null {
  switch (track.codecId) {
    case "S_TEXT/ASS":
    case "S_TEXT/SSA":
    case "S_SSA":
    case "S_ASS":
      return substationWriter(track);
    case "S_TEXT/UTF8":
      return { format: "srt", write: assembleSrt };
    case "D_WEBVTT/SUBTITLES":
    case "D_WEBVTT/CAPTIONS":
      return { format: "vtt", write: assembleVtt };
    case "S_HDMV/PGS":
      return { format: "sup", write: assembleSup };
    default:
      return null;
  }
}

function substationWriter(track: Track): Writer | null {
  const script = substationScript(track);
  if (script === null) return null;
  const write = (frames: readonly Frame[]) => assembleSubstation(script, frames);
  return { format: script.format, write };
}
