import type { Container } from "../container/contract.js";
import type { Frame, FrameOptions } from "../frames/contract.js";
import type { Track } from "../tracks.js";
import type { Bytes } from "../vocabulary.js";
import type { SubtitleFile, SubtitleFormat, SubtitlePiece } from "./contract.js";
import { type Assembler, Spool } from "./spool.js";
import { startSrt } from "./srt.js";
import { startSubstation, substationScript } from "./substation.js";
import { startSup } from "./sup.js";
import { startVtt } from "./vtt.js";

export interface SubtitleOptions extends FrameOptions {
  /**
   * The formats written out, unless named: the text ones, or every one when `tracks` is named.
   *
   * An unknown one is a TypeError.
   */
  formats?: readonly SubtitleFormat[];
  /**
   * The tracks written out, every one `container.tracks` lists unless named.
   *
   * A track the container does not list is a TypeError.
   */
  tracks?: readonly Track[];
}

/**
 * The format `subtitleFile` writes a track in: ASS, SSA, SubRip, WebVTT, or a PGS track's .sup.
 *
 * Null for any other track:
 * VobSub, a codec it does not know, or a SubStation track whose `codecPrivate` is null.
 */
export function subtitleFormat(track: Track): SubtitleFormat | null {
  return assemblyOf(track)?.format ?? null;
}

/**
 * Writes a track out as a file, from frames read for it that may hold other tracks' too.
 *
 * It answers null where `subtitleFormat` does.
 *
 * @example
 * const frames = await Array.fromAsync(container.frames([track]));
 * use(frames);
 * const sub = subtitleFile(track, frames);
 * if (sub !== null) use(track, sub.format, sub.bytes);
 */
export function subtitleFile(track: Track, frames: readonly Frame[]): SubtitleFile | null {
  const draft = draftOf(track);
  if (draft === null) return null;
  for (const frame of frames) draft.add(frame);
  return filed(track, draft);
}

/**
 * Writes out every track of `tracks` whose format `formats` names and that `readable` answers true for, from one read.
 *
 * It writes nothing where that read is refused.
 *
 * @example
 * for (const { track, format, bytes } of await subtitleFiles(container)) use(track, format, bytes);
 */
export async function subtitleFiles(
  container: Container,
  options: SubtitleOptions = {},
): Promise<SubtitleFile[]> {
  const written = writtenTracks(container, options);
  const drafts = new Map<number, Draft>();
  for (const track of written) {
    const draft = draftOf(track) as Draft;
    drafts.set(track.index, draft);
  }
  for await (const frame of container.frames(written, options)) {
    const draft = drafts.get(frame.trackIndex) as Draft;
    draft.add(frame);
  }
  return written.map((track) => {
    const draft = drafts.get(track.index) as Draft;
    return filed(track, draft);
  });
}

/**
 * Writes a track out as its frames come, for a file too large to hold whole.
 *
 * Null where `subtitleFormat` is.
 *
 * - It may hold a frame's bytes until the frames end, so the frame's buffer stays as given until then.
 *
 * @example
 * const sub = subtitleStream(track, container.frames([track], { via: "walk" }));
 * if (sub !== null) {
 *   await pipeline(sub.bytes, createWriteStream(`${track.index}.${sub.format}`));
 * }
 */
export function subtitleStream(
  track: Track,
  frames: AsyncIterable<Frame>,
): SubtitleFile<AsyncIterable<Bytes>> | null {
  const draft = draftOf(track);
  if (draft === null) return null;
  return { track, format: draft.format, bytes: streamed(draft, frames) };
}

/**
 * Writes out the tracks `subtitleFiles` would, in pieces as `subtitleStream` does, from one read.
 *
 * A track's pieces come in order, between other tracks' pieces.
 *
 * @example
 * for await (const { track, format, bytes } of subtitleStreams(container)) use(track, format, bytes);
 */
export function subtitleStreams(
  container: Container,
  options: SubtitleOptions = {},
): AsyncIterable<SubtitlePiece> {
  const written = writtenTracks(container, options);
  const drafts = written.map((track) => draftOf(track) as Draft);
  const frames = container.frames(written, options);
  return pieced(drafts, frames);
}

interface Assembly {
  format: SubtitleFormat;
  start: (out: Spool) => Assembler;
}

/** A track's file as its frames come. */
interface Draft {
  track: Track;
  format: SubtitleFormat;
  add(frame: Frame): void;
  end(): void;
  drain(): Uint8Array<ArrayBuffer>;
  waiting(): number;
}

const TEXT_FORMATS: ReadonlySet<SubtitleFormat> = new Set<SubtitleFormat>([
  "ass",
  "ssa",
  "srt",
  "vtt",
]);

const FORMATS: ReadonlySet<SubtitleFormat> = new Set<SubtitleFormat>([...TEXT_FORMATS, "sup"]);

/** What a stream gathers before it hands a piece on, as each piece costs its consumer a write. */
const PIECE_BYTES = 64 * 1024;

function writtenTracks(container: Container, options: SubtitleOptions): Track[] {
  const { formats, tracks } = { ...options };
  const byDefault = tracks === undefined ? TEXT_FORMATS : FORMATS;
  const named: ReadonlySet<SubtitleFormat | null> = formatsNamed(formats ?? byDefault);
  const asked = tracks ?? container.tracks;
  return asked.filter((track) => named.has(subtitleFormat(track)) && container.readable(track));
}

function formatsNamed(formats: Iterable<SubtitleFormat>): ReadonlySet<SubtitleFormat> {
  const named = new Set(formats);
  for (const format of named) {
    if (!FORMATS.has(format)) throw new TypeError(`unknown format ${String(format)}`);
  }
  return named;
}

function assemblyOf(track: Track): Assembly | null {
  switch (track.codecId) {
    case "S_TEXT/ASS":
    case "S_TEXT/SSA":
    case "S_SSA":
    case "S_ASS":
      return substationAssembly(track);
    case "S_TEXT/UTF8":
      return { format: "srt", start: startSrt };
    case "D_WEBVTT/SUBTITLES":
    case "D_WEBVTT/CAPTIONS":
      return { format: "vtt", start: startVtt };
    case "S_HDMV/PGS":
      return { format: "sup", start: startSup };
    default:
      return null;
  }
}

function substationAssembly(track: Track): Assembly | null {
  const script = substationScript(track);
  if (script === null) return null;
  return { format: script.format, start: (out) => startSubstation(script, out) };
}

function draftOf(track: Track): Draft | null {
  const assembly = assemblyOf(track);
  if (assembly === null) return null;
  const out = new Spool();
  const assembler = assembly.start(out);
  const add = (frame: Frame) => {
    const own = frame.trackIndex === track.index && frame.data.length > 0;
    if (own) assembler.add(frame);
  };
  const end = () => assembler.end?.();
  return {
    track,
    format: assembly.format,
    add,
    end,
    drain: () => out.drain(),
    waiting: () => out.waiting,
  };
}

function filed(track: Track, draft: Draft): SubtitleFile {
  draft.end();
  return { track, format: draft.format, bytes: draft.drain() };
}

async function* streamed(draft: Draft, frames: AsyncIterable<Frame>): AsyncGenerator<Bytes> {
  for await (const piece of pieced([draft], frames)) yield piece.bytes;
}

async function* pieced(
  drafts: readonly Draft[],
  frames: AsyncIterable<Frame>,
): AsyncGenerator<SubtitlePiece> {
  const byIndex = new Map(drafts.map((draft) => [draft.track.index, draft]));
  const handed = new Set<Draft>();
  for await (const frame of frames) {
    const draft = byIndex.get(frame.trackIndex);
    if (draft === undefined) continue;
    draft.add(frame);
    if (draft.waiting() >= PIECE_BYTES) {
      handed.add(draft);
      yield pieceOf(draft);
    }
  }
  for (const draft of drafts) {
    draft.end();
    // A track with nothing to write still comes out, as subtitleFiles writes it.
    if (draft.waiting() > 0 || !handed.has(draft)) yield pieceOf(draft);
  }
}

function pieceOf(draft: Draft): SubtitlePiece {
  return { track: draft.track, format: draft.format, bytes: draft.drain() };
}
