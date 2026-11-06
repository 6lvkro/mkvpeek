import type { Element, Window } from "../ebml.js";
import * as E from "../ebml.js";
import type { Range } from "../io/source.js";
import type { WindowIndex } from "../io/windows.js";
import {
  FRAME_IDS,
  type FrameClaim,
  readBlockFrame,
  relTicksIfTrack,
  type StoredFrame,
} from "./block.js";
import { CLUSTER_PROBE_BYTES, readClusterTicks, readsAs } from "./chain.js";
import type { CuePosition } from "./cues.js";
import { ID } from "./ids.js";

export interface LocatedBlock {
  blockAt: number;
  outer: Element;
  clusterBody: number;
  clusterTicks: number;
  window: Window;
}

export function readLocatedFrame(
  windows: WindowIndex,
  { outer, clusterTicks, window }: LocatedBlock,
  trackNumber: number,
  claims: ReadonlyMap<number, FrameClaim>,
): StoredFrame | null {
  const stored = readBlockFrame(outer, clusterTicks, window, claims, windows);
  // A cue must point to a block of its own track, so a block of another track leads nowhere.
  return typeof stored === "string" || stored?.trackNumber !== trackNumber ? null : stored;
}

export function planBlockRanges(points: readonly CuePosition[]): Range[] {
  const ranges: Range[] = [];
  for (const { clusterPos, relPos } of points) {
    ranges.push({ at: clusterPos + relPos, length: CUE_RANGE_BYTES });
  }
  return ranges;
}

export function planProbes(clusters: Iterable<number>): Range[] {
  const ranges: Range[] = [];
  for (const at of clusters) {
    ranges.push({ at, length: CLUSTER_PROBE_BYTES });
  }
  return ranges;
}

export function blockShortfall(
  windows: WindowIndex,
  { blockAt, outer }: LocatedBlock,
): Range | null {
  return windows.find(blockAt, outer.next - blockAt) === null
    ? { at: blockAt, length: outer.next - blockAt }
    : null;
}

export function locateByClusterHeads(
  windows: WindowIndex,
  points: readonly CuePosition[],
): (LocatedBlock | null)[] {
  let last: LastCluster | null = null;
  return points.map(({ clusterPos, relPos }) => {
    if (last === null || last.clusterPos !== clusterPos) {
      last = clusterAt(windows, clusterPos);
      if (last === null) return null;
    }
    const { cluster, clusterTicks } = last;
    if (clusterTicks === null) return null;
    const blockAt = cluster.body + relPos;
    if (blockAt >= cluster.next) return null;
    const need = E.headerNeed(blockAt, cluster.next);
    const window = E.covers(last.window, blockAt, need) ? last.window : windows.find(blockAt, need);
    if (window === null) return null;
    last.window = window;
    const outer = E.readElement(window, blockAt);
    if (!E.fits(outer, cluster.next) || !FRAME_IDS.has(outer.id)) return null;
    return { blockAt, outer, clusterBody: cluster.body, clusterTicks, window };
  });
}

/**
 * The track's block found from the cue alone, where exactly one cluster header width parses one past the cue.
 *
 * The cluster's body and clock are what the block's position and the cue's time imply.
 */
export function locateByCue(
  windows: WindowIndex,
  point: CuePosition,
  trackNumber: number,
): LocatedBlock | null {
  const { clusterPos, relPos, ticks } = point;
  if (ticks === null) return null;
  const window = windows.find(clusterPos + relPos, CUE_RANGE_BYTES);
  if (window === null) return null;
  let cued: LocatedBlock | null = null;
  for (let width = MIN_CLUSTER_HEADER_BYTES; width <= MAX_CLUSTER_HEADER_BYTES; width++) {
    const clusterBody = clusterPos + width;
    const blockAt = clusterBody + relPos;
    // Both frame IDs are one byte long, so the byte a width lands on is the ID it would read.
    if (!FRAME_IDS.has(window.bytes[blockAt - window.at] as number)) continue;
    if (!E.readElementInto(window, blockAt, OUTER) || OUTER.open) continue;
    const relTicks = relTicksIfTrack(window, OUTER, trackNumber);
    if (relTicks === null) continue;
    if (cued !== null) return null;
    const outer = { id: OUTER.id, size: OUTER.size, body: OUTER.body, next: OUTER.next };
    cued = { blockAt, outer, clusterBody, clusterTicks: ticks - relTicks, window };
  }
  return cued;
}

interface LastCluster {
  clusterPos: number;
  cluster: Element;
  clusterTicks: number | null;
  window: Window;
}

const CLUSTER_ID_BYTES = 4;

const MIN_CLUSTER_HEADER_BYTES = CLUSTER_ID_BYTES + 1;

const MAX_CLUSTER_HEADER_BYTES = CLUSTER_ID_BYTES + E.MAX_VINT_BYTES;

const CUE_AHEAD_BYTES = 256;

const CUE_RANGE_BYTES = MAX_CLUSTER_HEADER_BYTES + CUE_AHEAD_BYTES;

// locateByCue is synchronous, so every cue reuses this cursor without mixing its reads.
const OUTER = E.elementCursor();

function clusterAt(windows: WindowIndex, clusterPos: number): LastCluster | null {
  const clusterHead = windows.find(clusterPos, CLUSTER_PROBE_BYTES);
  if (clusterHead === null) return null;
  const cluster = E.readElement(clusterHead, clusterPos);
  if (!readsAs(cluster, ID.segment.CLUSTER)) return null;
  const clusterTicks = readClusterTicks(clusterHead, cluster);
  return { clusterPos, cluster, clusterTicks, window: clusterHead };
}
