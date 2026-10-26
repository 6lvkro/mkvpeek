import type { Undo } from "../matroska/encoding.js";
import type { OpenedTrack } from "../matroska/header.js";
import type { Track, TrackType } from "../vocabulary.js";

export type ClaimsByNumber = ReadonlyMap<number, TrackClaim>;

export interface TrackClaim {
  track: Track;
  /** The NUMBER_OF_FRAMES the container states for the track, or null where it states none. */
  statedFrames: number | null;
  undo: Undo | null;
}

export function claimFor({ track, undo }: OpenedTrack): TrackClaim | null {
  if (!READABLE_TYPES.has(track.type) || undo === false) return null;
  const statedFrames = statedFrameCount(track);
  return { track, statedFrames, undo };
}

/**
 * Whether `count` cues are taken to name every frame of the track.
 *
 * Unless the read is strict, a track that states no count is taken at its cues' word.
 */
export function vouchable({ statedFrames }: TrackClaim, count: number, strict: boolean): boolean {
  if (count === 0 || strict) return statedFrames === count;
  return statedFrames === null || statedFrames === count;
}

/** Subtitle blocks are unlaced, and each subtitle frame has a cue point. */
const READABLE_TYPES: ReadonlySet<TrackType> = new Set(["subtitle"]);

function statedFrameCount({ tags }: Track): number | null {
  const stated = tags.find((tag) => tag.name === "NUMBER_OF_FRAMES");
  if (stated === undefined) return null;
  const count = stated.value.trim() === "" ? Number.NaN : Number(stated.value);
  return Number.isInteger(count) ? count : null;
}
