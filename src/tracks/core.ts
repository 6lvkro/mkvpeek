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
  /** null when the track states none, or states an encoding over them. */
  codecPrivate: Uint8Array | null;
  /** Exactly what the container states, unnormalised; only no statement is null. */
  language: string | null;
  languageIetf: string | null;
  name: string | null;
  flags: TrackFlags;
  codecDelayNs: number;
  tags: TrackTag[];
}

export const trackCore = <T extends TrackType>(
  { typeCode, encodings, ...stated }: TrackEntry,
  header: TracksHeader,
  type: T,
): Track<T> => ({
  type,
  ...stated,
  tags: tagsOf(header, stated).map((tag) => ({ ...tag })),
});

export const kindOf = (track: TrackEntry): TrackType =>
  KIND_BY_TYPE_CODE.get(track.typeCode) ?? "unknown";

export const tagsOf = (header: TracksHeader, { uid }: Pick<TrackEntry, "uid">): TrackTag[] =>
  uid === null ? [] : (header.trackTags.get(uid) ?? []);

const KIND_BY_TYPE_CODE: ReadonlyMap<number, TrackType> = new Map([
  [1, "video"],
  [2, "audio"],
  [3, "complex"],
  [16, "logo"],
  [17, "subtitle"],
  [18, "buttons"],
  [32, "control"],
  [33, "metadata"],
]);
