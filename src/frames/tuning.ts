import type { IndexFetch, Trip, WalkFetch } from "../io/source.js";
import { givenSignal, MAX_SPAN_BYTES } from "../io/source.js";
import type { FetchKnobs, FrameOptions, FramePreset, FrameProgress, FrameVia } from "./contract.js";

export interface SettledFrameOptions {
  via: FrameVia;
  strict: boolean;
  knobsForIndex: IndexFetch;
  knobsForWalk: WalkFetch;
  onProgress: ((progress: FrameProgress) => void) | undefined;
  signal: AbortSignal | undefined;
}

export function settledFrameOptions(
  options: FrameOptions,
  trip: Trip | undefined,
): SettledFrameOptions {
  const via = options.via ?? DEFAULT_VIA;
  const strict = options.strict === true;
  const presetAsked = options.preset ?? DEFAULT_PRESET;
  const preset = Object.hasOwn(TUNING, presetAsked) ? presetAsked : DEFAULT_PRESET;
  const column = trip !== undefined && Object.hasOwn(TUNING[preset], trip) ? trip : "mount";
  const shipped = TUNING[preset][column];
  const given = options.overrides ?? {};
  const knob = (key: keyof FetchKnobs, fallback: number) => clampedKnob(given[key], fallback, key);
  const knobsForIndex = {
    gapBytes: knob("gapBytes", shipped.gapBytes),
    cueAheadBytes: knob("cueAheadBytes", shipped.cueAheadBytes),
    concurrency: knob("concurrency", INDEX_CONCURRENCY),
  };
  const knobsForWalk = {
    blockAheadBytes: knob("blockAheadBytes", shipped.blockAheadBytes),
    concurrency: knob("concurrency", shipped.concurrency),
  };
  const { onProgress } = options;
  const signal = givenSignal(options.signal);
  return { via, strict, knobsForIndex, knobsForWalk, onProgress, signal };
}

type TuningByTrip = Record<Trip, Readonly<FetchKnobs>>;

const DEFAULT_VIA: FrameVia = "both";

const DEFAULT_PRESET: FramePreset = "balanced";

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

const TUNING: Record<FramePreset, TuningByTrip> = {
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
