import type { Inflate } from "../io/source.js";
import { FRAMES_SCOPE, type Undo, undoFor } from "../matroska/encoding.js";
import type { CueIndex, OpenedSegment, TrackEntry } from "../matroska/header.js";
import { type TrackType, tagsOf, trackTypeOf } from "../tracks.js";
import type { ContainerInfo } from "../vocabulary.js";

export interface FrameFile extends OpenedSegment {
  info: ContainerInfo;
  inflate: Inflate;
  firstClusterTicks(signal: AbortSignal): Promise<number | null>;
  cues(signal: AbortSignal): Promise<CueIndex>;
}

export interface TrackClaim {
  entry: TrackEntry;
  /** The NUMBER_OF_FRAMES the container states for the track, or null where it states none. */
  statedFrames: number | null;
  undo: Undo | null;
}

export function claimFor(entry: TrackEntry, file: FrameFile): TrackClaim | null {
  if (!READABLE_TYPES.has(trackTypeOf(entry))) return null;
  const undo = undoFor(entry.encodings, FRAMES_SCOPE, file.inflate);
  if (undo === false) return null;
  const statedFrames = statedFrameCount(file, entry);
  return { entry, statedFrames, undo };
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

function statedFrameCount(file: FrameFile, entry: TrackEntry): number | null {
  const stated = tagsOf(file, entry).find((tag) => tag.name === "NUMBER_OF_FRAMES");
  if (stated === undefined) return null;
  const count = stated.value.trim() === "" ? Number.NaN : Number(stated.value);
  return Number.isInteger(count) ? count : null;
}
