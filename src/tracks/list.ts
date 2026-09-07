import type { TracksHeader } from "../matroska/header.js";
import { kindOf, type Track, type TrackType, trackCore } from "./core.js";
import { type SubtitleTrack, subtitleTrack } from "./subtitle.js";

export type ListedTrack = SubtitleTrack | Track<Exclude<TrackType, SpecializedType>>;

/** The track types that have a specialised shape beyond the core. */
type SpecializedType = "subtitle";

export const allTracks = (header: TracksHeader): ListedTrack[] =>
  header.trackEntries.map((track) => {
    const kind = kindOf(track);
    return kind === "subtitle" ? subtitleTrack(track, header) : trackCore(track, header, kind);
  });
