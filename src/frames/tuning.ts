import type { FetchKnobs, IndexFetch, Trip, WalkFetch } from "../io/source.js";
import { givenSignal } from "../io/source.js";
import type { FrameOptions, FramePreset, FrameProgress, FrameVia } from "./contract.js";

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
  if (!FRAME_VIAS.has(via)) throw new TypeError(`unknown via ${String(via)}`);
  const strict = options.strict ?? false;
  if (typeof strict !== "boolean") throw new TypeError(`strict ${String(strict)} is not a boolean`);
  const preset = options.preset ?? DEFAULT_PRESET;
  if (!Object.hasOwn(TUNING, preset)) throw new TypeError(`unknown preset ${String(preset)}`);
  const column = trip !== undefined && Object.hasOwn(TUNING[preset], trip) ? trip : "mount";
  const shipped = TUNING[preset][column];
  const { concurrency } = options;
  const knobsForIndex = {
    gapBytes: shipped.gapBytes,
    cueAheadBytes: shipped.cueAheadBytes,
    concurrency: checkedConcurrency(concurrency, INDEX_CONCURRENCY),
  };
  const knobsForWalk = {
    blockAheadBytes: shipped.blockAheadBytes,
    concurrency: checkedConcurrency(concurrency, shipped.concurrency),
  };
  const { onProgress } = options;
  const signal = givenSignal(options.signal);
  return { via, strict, knobsForIndex, knobsForWalk, onProgress, signal };
}

type TuningByTrip = Record<Trip, Readonly<FetchKnobs>>;

const DEFAULT_VIA: FrameVia = "both";

const FRAME_VIAS = new Set<FrameVia>(["both", "index", "walk"]);

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

const MAX_CONCURRENCY = 64;

function checkedConcurrency(given: number | undefined, shipped: number): number {
  const concurrency = given ?? shipped;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency ${String(concurrency)} is not an integer of at least 1`);
  }
  return Math.min(concurrency, MAX_CONCURRENCY);
}
