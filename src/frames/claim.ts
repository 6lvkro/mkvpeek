import type { Inflate } from "../io/source.js";
import type { ClaimedFrame } from "../matroska/block.js";
import { FRAMES_SCOPE, type Undo, undoFor } from "../matroska/encoding.js";
import type { CueIndex, OpenedSegment, TrackEntry } from "../matroska/header.js";
import { type TrackType, tagsOf, trackTypeOf } from "../tracks.js";
import type { ContainerInfo } from "../vocabulary.js";

export interface FrameFile extends OpenedSegment {
  info: ContainerInfo;
  inflate: Inflate;
  witnessOf: WitnessOf;
  firstClusterTicks(signal: AbortSignal): Promise<number | null>;
  cues(signal: AbortSignal): Promise<CueIndex>;
}

export interface TrackClaim {
  entry: TrackEntry;
  /** The NUMBER_OF_FRAMES the container states for the track, or null where it states none. */
  statedFrames: number | null;
  undo: Undo | null;
  witness: Witness | null;
}

/** Judges whether the frames a cue list found are every frame of the track, or null where they cannot tell. */
export type Witness = (frames: readonly WitnessedFrame[]) => Verdict | null;

export type WitnessOf = (entry: TrackEntry) => Witness | null;

export type WitnessedFrame = Pick<ClaimedFrame, "payload" | "durationTicks">;

/**
 * - `whole`: the run is every frame of the track.
 *
 * - `broken`: the run cannot be every frame.
 */
type Verdict = "whole" | "broken";

export function claimFor(entry: TrackEntry, file: FrameFile): TrackClaim | null {
  if (!READABLE_TYPES.has(trackTypeOf(entry))) return null;
  const undo = undoFor(entry.encodings, FRAMES_SCOPE, file.inflate);
  if (undo === false) return null;
  const statedFrames = statedFrameCount(file, entry);
  const witness = file.witnessOf(entry);
  return { entry, statedFrames, undo, witness };
}

/**
 * Whether the frames a read found are every frame of a track.
 *
 * None is every frame only where the track states that it has none.
 */
export function vouched(claim: TrackClaim, frames: readonly WitnessedFrame[]): boolean {
  if (!vouchable(claim, frames.length)) return false;
  if (frames.length === 0) return true;
  const verdict = claim.witness?.(frames);
  return verdict === "whole" || (verdict !== "broken" && claim.statedFrames !== null);
}

/** Whether this many frames of a track could be vouched for, known before they are read. */
export function vouchable({ statedFrames, witness }: TrackClaim, count: number): boolean {
  if (count === 0) return statedFrames === 0;
  return statedFrames === null ? witness !== null : statedFrames === count;
}

/** Subtitle blocks are unlaced, and each subtitle frame has a cue point. */
const READABLE_TYPES: ReadonlySet<TrackType> = new Set(["subtitle"]);

function statedFrameCount(file: FrameFile, entry: TrackEntry): number | null {
  const stated = tagsOf(file, entry).find((tag) => tag.name === "NUMBER_OF_FRAMES");
  if (stated === undefined) return null;
  const count = stated.value.trim() === "" ? Number.NaN : Number(stated.value);
  return Number.isInteger(count) ? count : null;
}
