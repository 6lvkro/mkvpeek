import type { OpenedSegment, TrackEntry } from "./matroska/header.js";
import type { TrackFlags, TrackTag } from "./vocabulary.js";

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
  /** The TrackUID in hexadecimal, null where it is unstated. */
  uid: string | null;
  /** The Matroska CodecID, such as `S_TEXT/ASS`. */
  codecId: string;
  /** null when the track states none, or states an encoding over it this reader cannot undo. */
  codecPrivate: Uint8Array | null;
  /** Exactly what the container states, unnormalised; only no statement is null. */
  language: string | null;
  /** The BCP 47 language, passed through as `language` is. */
  languageIetf: string | null;
  name: string | null;
  flags: TrackFlags;
  /** Frame times already account for the largest CodecDelay any track states. */
  codecDelayNs: number;
  /** The SimpleTags of every Tag that targets this track's TrackUID. */
  tags: TrackTag[];
}

/** Each call answers tracks of their own, which share nothing with the file or with another call. */
export const allTracks = (segment: OpenedSegment): Track[] =>
  segment.trackEntries.map((entry) => {
    const track = trackOf(segment, entry);
    const codecPrivate = track.codecPrivate === null ? null : track.codecPrivate.slice();
    const flags = { ...track.flags };
    const tags = track.tags.map((tag) => ({ ...tag }));
    return { ...track, codecPrivate, flags, tags };
  });

export const trackTypeOf = (entry: TrackEntry): TrackType =>
  TYPE_BY_CODE.get(entry.typeCode) ?? "unknown";

export const tagsOf = ({ trackTags }: OpenedSegment, { uid }: TrackEntry): TrackTag[] =>
  uid === null ? [] : (trackTags.get(uid) ?? []);

/** The track an entry states, sharing the entry's bytes and objects. */
export function trackOf(segment: OpenedSegment, entry: TrackEntry): Track {
  const { typeCode, encodings, ...stated } = entry;
  return { type: trackTypeOf(entry), ...stated, tags: tagsOf(segment, entry) };
}

const TYPE_BY_CODE: ReadonlyMap<number, TrackType> = new Map([
  [1, "video"],
  [2, "audio"],
  [3, "complex"],
  [16, "logo"],
  [17, "subtitle"],
  [18, "buttons"],
  [32, "control"],
  [33, "metadata"],
]);
