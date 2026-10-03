import type { Track } from "../tracks.js";

export interface SubtitleFile {
  track: Track;
  format: "ass" | "ssa" | "srt" | "vtt";
  text: string;
}
