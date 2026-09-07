import type { IndexFetch, Source, Trip, WalkFetch } from "../io/source.js";
import { MAX_SPAN_BYTES } from "../io/source.js";
import type { FetchKnobs, SubtitlePreset, SubtitleTuning } from "./options.js";

export function knobsForIndex(source: Source, options: SubtitleTuning): IndexFetch {
  const given = options.overrides;
  const shipped = shippedFor(source, options);
  return {
    gapBytes: clampedKnob(given?.gapBytes, shipped.gapBytes, "gapBytes"),
    cueAheadBytes: clampedKnob(given?.cueAheadBytes, shipped.cueAheadBytes, "cueAheadBytes"),
    concurrency: clampedKnob(given?.concurrency, INDEX_CONCURRENCY, "concurrency"),
  };
}

export function knobsForWalk(source: Source, options: SubtitleTuning): WalkFetch {
  const given = options.overrides;
  const shipped = shippedFor(source, options);
  return {
    blockAheadBytes: clampedKnob(
      given?.blockAheadBytes,
      shipped.blockAheadBytes,
      "blockAheadBytes",
    ),
    concurrency: clampedKnob(given?.concurrency, shipped.concurrency, "concurrency"),
  };
}

type TuningByTransport = Record<Trip, Readonly<FetchKnobs>>;

const DEFAULT_PRESET: SubtitlePreset = "balanced";

const INDEX_CONCURRENCY = 16;

const TRIP_BLIND: Readonly<FetchKnobs> = {
  gapBytes: 0,
  cueAheadBytes: 256,
  blockAheadBytes: 0,
  concurrency: 16,
};

const LOCAL_KNOBS: Readonly<FetchKnobs> = {
  gapBytes: 8 * 1024,
  cueAheadBytes: 256,
  blockAheadBytes: 2 * 1024 ** 2,
  concurrency: 2,
};

const MOUNT_KNOBS: Readonly<FetchKnobs> = {
  gapBytes: 16 * 1024,
  cueAheadBytes: 256,
  blockAheadBytes: 128,
  concurrency: 16,
};

const REMOTE_KNOBS: Readonly<FetchKnobs> = {
  gapBytes: 64 * 1024,
  cueAheadBytes: 1024,
  blockAheadBytes: 8 * 1024,
  concurrency: 16,
};

const TUNING: Record<SubtitlePreset, TuningByTransport> = {
  leanest: { local: TRIP_BLIND, mount: TRIP_BLIND, remote: TRIP_BLIND },
  balanced: { local: LOCAL_KNOBS, mount: MOUNT_KNOBS, remote: REMOTE_KNOBS },
  fastest: {
    local: LOCAL_KNOBS,
    mount: { ...MOUNT_KNOBS, blockAheadBytes: 16 * 1024 },
    remote: { ...REMOTE_KNOBS, blockAheadBytes: 64 * 1024 },
  },
};

const KNOB_MIN: FetchKnobs = {
  gapBytes: 0,
  cueAheadBytes: 16,
  blockAheadBytes: 0,
  concurrency: 1,
};

const KNOB_MAX: FetchKnobs = {
  gapBytes: Number.POSITIVE_INFINITY,
  cueAheadBytes: MAX_SPAN_BYTES / 4,
  blockAheadBytes: MAX_SPAN_BYTES,
  concurrency: 64,
};

/**
 * A read length, so it has to be an integer.
 *
 * Anything else, or below the minimum, falls back to the shipped value;
 * above the maximum sits at the maximum.
 */
const clampedKnob = (given: number | undefined, shipped: number, key: keyof FetchKnobs): number =>
  given !== undefined && Number.isInteger(given) && given >= KNOB_MIN[key]
    ? Math.min(given, KNOB_MAX[key])
    : shipped;

function shippedFor(source: Source, options: SubtitleTuning): Readonly<FetchKnobs> {
  const trip = source.trip;
  const column = trip !== undefined && Object.hasOwn(TUNING[DEFAULT_PRESET], trip) ? trip : "mount";
  const row =
    options.preset !== undefined && Object.hasOwn(TUNING, options.preset)
      ? options.preset
      : DEFAULT_PRESET;
  return TUNING[row][column];
}
