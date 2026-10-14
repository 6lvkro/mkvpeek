import type { Element, Window } from "../ebml.js";
import * as E from "../ebml.js";
import type { Range } from "../io/source.js";
import type { WindowIndex } from "../io/windows.js";
import {
  BLOCK_REFUSAL,
  type BlockClause,
  blockSteps,
  FRAME_IDS,
  type FrameClaim,
  heldBlockHead,
  type StoredFrame,
} from "./block.js";
import {
  CLUSTER_PROBE_BYTES,
  ELEMENT_HEADER_BYTES,
  headerNeed,
  readClusterTicks,
} from "./chain.js";
import type { CuePosition } from "./header.js";

/** Points naming the same cluster in a row share its element, its time and the last window. */
export interface ClusterMemo {
  last: LastCluster | null;
}

/**
 * A block found from its cue alone, with its cluster's head unread.
 *
 * The cluster's body and clock are what the block's position and the cue's time imply.
 */
export interface CuedBlock {
  blockAt: number;
  outer: Element;
  clusterBody: number;
  clusterTicks: number;
  window: Window;
}

interface LastCluster {
  clusterPos: number;
  cluster: Element;
  clusterTicks: number | null;
  window: Window;
}

export function readFrame(
  windows: WindowIndex,
  point: CuePosition,
  trackNumber: number,
  claim: FrameClaim,
  memo: ClusterMemo,
): StoredFrame | BlockClause {
  const pointed = locateBlock(windows, point, memo);
  if (typeof pointed === "string") return pointed;
  const { clusterTicks, window, outer } = pointed;

  if (clusterTicks === null) return BLOCK_REFUSAL.noClusterTime;

  return frameOfBlock(windows, outer, clusterTicks, window, trackNumber, claim);
}

export function readCuedFrame(
  windows: WindowIndex,
  cued: CuedBlock,
  trackNumber: number,
  claim: FrameClaim,
): StoredFrame | BlockClause {
  const { outer, clusterTicks, window } = cued;
  return frameOfBlock(windows, outer, clusterTicks, window, trackNumber, claim);
}

export function planBlockRanges(points: readonly CuePosition[], cueAheadBytes: number): Range[] {
  const ranges: Range[] = [];
  for (const { clusterPos, relPos } of points) {
    ranges.push({ at: clusterPos + relPos, length: MAX_CLUSTER_HEADER_BYTES + cueAheadBytes });
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

/** Each point's block bytes the windows do not hold, null where they hold them all or the block does not locate. */
export function pointShortfalls(
  windows: WindowIndex,
  points: readonly CuePosition[],
): (Range | null)[] {
  const memo: ClusterMemo = { last: null };
  return points.map((point) => {
    const pointed = locateBlock(windows, point, memo);
    if (typeof pointed === "string") return null;
    return unheldBlock(windows, pointed.blockAt, pointed.outer);
  });
}

export function cuedShortfall(windows: WindowIndex, { blockAt, outer }: CuedBlock): Range | null {
  return unheldBlock(windows, blockAt, outer);
}

/** The one block of the track that parses past the cue's position at some cluster-header width. */
export function locateByCue(
  windows: WindowIndex,
  point: CuePosition,
  trackNumber: number,
): CuedBlock | null {
  const { clusterPos, relPos, ticks } = point;
  if (ticks === null) return null;
  const window = windows.find(clusterPos + relPos, MAX_CLUSTER_HEADER_BYTES);
  if (window === null) return null;
  let cued: CuedBlock | null = null;
  for (let width = MIN_CLUSTER_HEADER_BYTES; width <= MAX_CLUSTER_HEADER_BYTES; width++) {
    const clusterBody = clusterPos + width;
    const blockAt = clusterBody + relPos;
    // Both frame IDs are one byte long, so the byte a width lands on is the ID it would read.
    if (!FRAME_IDS.has(window.bytes[blockAt - window.at] as number)) continue;
    const outer = E.readElement(window, blockAt);
    if (!E.decoded(outer)) continue;
    const blockHead = heldBlockHead(window, outer);
    if (blockHead === null || blockHead.trackNumber !== trackNumber) continue;
    if (cued !== null) return null;
    cued = { blockAt, outer, clusterBody, clusterTicks: ticks - blockHead.relTicks, window };
  }
  return cued;
}

interface PointedBlock {
  clusterTicks: number | null;
  window: Window;
  blockAt: number;
  outer: Element;
}

const CLUSTER_ID_BYTES = 4;

const MIN_CLUSTER_HEADER_BYTES = CLUSTER_ID_BYTES + 1;

const MAX_CLUSTER_HEADER_BYTES = CLUSTER_ID_BYTES + E.MAX_VINT_BYTES;

const unheldBlock = (windows: WindowIndex, blockAt: number, outer: Element): Range | null =>
  windows.find(blockAt, outer.next - blockAt) === null
    ? { at: blockAt, length: outer.next - blockAt }
    : null;

function frameOfBlock(
  windows: WindowIndex,
  outer: Element,
  clusterTicks: number,
  held: Window,
  trackNumber: number,
  claim: FrameClaim,
): StoredFrame | BlockClause {
  const claims = new Map([[trackNumber, claim]]);
  const steps = blockSteps(outer, clusterTicks, held, claims);
  let step = steps.next();
  while (step.done !== true) {
    const window = windows.find(step.value.at, step.value.length);
    if (window === null) return BLOCK_REFUSAL.notFetched;
    step = steps.next(window);
  }
  return step.value ?? BLOCK_REFUSAL.notThisTrack;
}

function locateBlock(
  windows: WindowIndex,
  { clusterPos, relPos }: CuePosition,
  memo: ClusterMemo,
): PointedBlock | BlockClause {
  let last = memo.last;
  if (last === null || last.clusterPos !== clusterPos) {
    const clusterHead = windows.find(clusterPos, ELEMENT_HEADER_BYTES);
    if (clusterHead === null) return BLOCK_REFUSAL.notFetched;
    const cluster = E.readElement(clusterHead, clusterPos);
    if (typeof cluster === "string" || cluster.id !== E.ID.segment.CLUSTER) {
      return BLOCK_REFUSAL.notACluster;
    }
    if ("open" in cluster) return BLOCK_REFUSAL.openCluster;
    const clusterTicks = readClusterTicks(clusterHead, cluster);
    last = { clusterPos, cluster, clusterTicks, window: clusterHead };
    memo.last = last;
  }
  const { cluster, clusterTicks } = last;
  const blockAt = cluster.body + relPos;
  const need = headerNeed(blockAt, cluster.next);
  const held = last.window;
  const window = E.covers(held, blockAt, need) ? held : windows.find(blockAt, need);
  if (window === null) return BLOCK_REFUSAL.notFetched;
  last.window = window;

  const outer = E.readElement(window, blockAt);
  if (!E.fits(outer, cluster.next)) return BLOCK_REFUSAL.runsPastCluster;
  if (!FRAME_IDS.has(outer.id)) return BLOCK_REFUSAL.notABlock;
  return { clusterTicks, window, blockAt, outer };
}
