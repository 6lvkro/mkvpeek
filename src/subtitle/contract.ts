import type { Track } from "../tracks.js";
import type { Bytes } from "../vocabulary.js";

/** A subtitle file's format, by its extension. */
export type SubtitleFormat = "ass" | "ssa" | "srt" | "vtt" | "sup";

export interface SubtitleFile<T = Bytes> {
  track: Track;
  format: SubtitleFormat;
  /** UTF-8 for the text formats. */
  bytes: T;
}

/** The next bytes of a track's file. */
export interface SubtitlePiece {
  track: Track;
  format: SubtitleFormat;
  bytes: Bytes;
}
