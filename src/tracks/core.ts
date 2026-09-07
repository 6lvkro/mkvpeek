import type { TrackEntry, TracksHeader } from "../matroska/header.js";
import type { TrackFlags, TrackTag } from "../vocabulary.js";

export type TrackType =
  | "video"
  | "audio"
  | "complex"
  | "logo"
  | "subtitle"
  | "buttons"
  | "control"
  | "metadata"
  | "unknown";

export interface Track<T extends TrackType = TrackType> {
  type: T;
  /**
   * The position in the track list.
   *
   * The same count as ffmpeg's `0:N`.
   */
  index: number;
  /** The container's TrackNumber. */
  number: number;
  uid: string | null;
  codecId: string;
  /** Exactly what the container states, unnormalised; only no statement is null. */
  language: string | null;
  languageIetf: string | null;
  name: string | null;
  flags: TrackFlags;
  codecDelayNs: number;
  tags: TrackTag[];
}

export const kindOf = (track: TrackEntry): TrackType => KIND_BY_TYPE.get(track.type) ?? "unknown";

export const trackCore = <T extends TrackType>(
  track: TrackEntry,
  header: TracksHeader,
  type: T,
): Track<T> => ({
  type: type,
  index: track.streamIndex,
  number: track.number,
  uid: track.uid,
  codecId: track.codecId,
  language: track.language,
  languageIetf: track.languageIetf,
  name: track.name,
  flags: { ...track.flags },
  codecDelayNs: track.codecDelayNs,
  tags:
    track.uid === null ? [] : (header.trackTags.get(track.uid) ?? []).map((tag) => ({ ...tag })),
});

const KIND_BY_TYPE: ReadonlyMap<number, TrackType> = new Map([
  [1, "video"],
  [2, "audio"],
  [3, "complex"],
  [16, "logo"],
  [17, "subtitle"],
  [18, "buttons"],
  [32, "control"],
  [33, "metadata"],
]);
