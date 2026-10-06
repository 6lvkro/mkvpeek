import type { Track } from "../tracks.js";

/** A subtitle file's format, by its extension. */
export type SubtitleFormat = "ass" | "ssa" | "srt" | "vtt" | "sup";

export interface SubtitleFile {
  track: Track;
  format: SubtitleFormat;
  /** UTF-8 for the text formats. */
  bytes: Uint8Array;
}
