import type { Bytes, Track } from "../vocabulary.js";

/** The next bytes of a track's file. */
export type SubtitlePiece = SubtitleFile;

export interface SubtitleFile<T = Bytes> {
  track: Track;
  format: SubtitleFormat;
  /** UTF-8 for the text formats. */
  bytes: T;
}

/** A subtitle file's format, by its extension. */
export type SubtitleFormat = "ass" | "ssa" | "srt" | "vtt" | "sup";
