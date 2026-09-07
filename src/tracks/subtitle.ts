import type { TrackEntry, TracksHeader } from "../matroska/header.js";
import type { SubtitleFinder } from "../vocabulary.js";
import { kindOf, type Track, trackCore } from "./core.js";

export interface SubtitleTrack extends Track<"subtitle"> {
  /** Its `null` state and {@linkcode unsupported} are mutually exclusive. */
  format: "ass" | "srt" | "vtt" | null;
  /**
   * The subtitle track's body.
   *
   * null when it was not served, for one of the reasons below.
   *
   * - `SubtitleOptions.text===false`: bodies were explicitly not requested
   *
   * - {@linkcode unsupported}: this reader does not handle the track
   *
   * - `RefusalCode`: the read was refused
   */
  text: string | null;
  /**
   * The finder that served the body.
   *
   * It goes with {@linkcode text}: when the body is null, so is this.
   */
  servedBy: SubtitleFinder | null;
  /**
   * Describes what this reader does not handle, not a verdict on the track itself.
   *
   * - `codec`: PGS image subtitles, S_TEXT/USF, D_WEBVTT/METADATA and the like
   *
   * - `content-encoded`: the container says the frames are zlib-compressed,
   *   header-stripped or encrypted
   *
   * - `null`: a kind the reader handles, which **does not guarantee it is always served**
   */
  unsupported: "codec" | "content-encoded" | null;
}

type SubtitleFormat = NonNullable<SubtitleTrack["format"]>;

export const SUPPORTED_CODECS: ReadonlyMap<string, SubtitleFormat> = new Map([
  ["S_TEXT/ASS", "ass"],
  ["S_TEXT/SSA", "ass"],
  ["S_SSA", "ass"],
  ["S_ASS", "ass"],
  ["S_TEXT/UTF8", "srt"],
  ["D_WEBVTT/SUBTITLES", "vtt"],
  ["D_WEBVTT/CAPTIONS", "vtt"],
]);

export const subtitleTracks = (header: TracksHeader): SubtitleTrack[] =>
  subtitleEntries(header).map((track) => subtitleTrack(track, header));

export const subtitleEntries = (header: TracksHeader): TrackEntry[] =>
  header.trackEntries.filter((track) => kindOf(track) === "subtitle");

export const isSupported = (track: TrackEntry): boolean => unsupportedReason(track) === null;

export const isNumbered = (track: TrackEntry): boolean =>
  SUPPORTED_CODECS.get(track.codecId) === "ass";

export function subtitleTrack(track: TrackEntry, header: TracksHeader): SubtitleTrack {
  const unsupported = unsupportedReason(track);
  return {
    ...trackCore(track, header, "subtitle"),
    format: unsupported === null ? (SUPPORTED_CODECS.get(track.codecId) ?? null) : null,
    // filling the body is the job of the layer that knows which finder served it
    text: null,
    servedBy: null,
    unsupported,
  };
}

export function statedFrameCount(header: TracksHeader, track: TrackEntry): number | null {
  if (track.uid === null) return null;
  const stated = header.trackTags.get(track.uid)?.find((tag) => tag.name === "NUMBER_OF_FRAMES");
  if (stated === undefined) return null;
  const parsed = stated.value.trim() === "" ? Number.NaN : Number(stated.value);
  return Number.isInteger(parsed) ? parsed : null;
}

function unsupportedReason(track: TrackEntry): SubtitleTrack["unsupported"] {
  if (!SUPPORTED_CODECS.has(track.codecId)) return "codec";
  return track.encoded ? "content-encoded" : null;
}
