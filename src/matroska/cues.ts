import type { Element, Window } from "../ebml.js";
import * as E from "../ebml.js";
import type { Range } from "../io/source.js";
import type { WindowIndex } from "../io/windows.js";
import {
  BLOCK_REFUSAL,
  type BlockClause,
  type BlockFrame,
  type BytesSupply,
  type FrameClaim,
  frameIn,
  heldBlockHead,
} from "./block.js";
import {
  CLUSTER_PROBE_BYTES,
  ELEMENT_HEADER_BYTES,
  FRAME_IDS,
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

export async function readFrame(
  windows: WindowIndex,
  point: CuePosition,
  trackNumber: number,
  claim: FrameClaim,
  memo: ClusterMemo,
): Promise<BlockFrame | BlockClause> {
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
): Promise<BlockFrame | BlockClause> {
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

export function planShortfall(windows: WindowIndex, points: readonly CuePosition[]): Range[] {
  const ranges: Range[] = [];
  const memo: ClusterMemo = { last: null };
  for (const point of points) {
    const pointed = locateBlock(windows, point, memo);
    if (typeof pointed === "string") continue;
    const { blockAt, outer } = pointed;
    const rest = unheldBlock(windows, blockAt, outer);
    if (rest !== null) ranges.push(rest);
  }
  return ranges;
}

export function planCuedShortfall(windows: WindowIndex, blocks: Iterable<CuedBlock>): Range[] {
  const ranges: Range[] = [];
  for (const { blockAt, outer } of blocks) {
    const rest = unheldBlock(windows, blockAt, outer);
    if (rest !== null) ranges.push(rest);
  }
  return ranges;
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
    const outer = E.readElement(window, blockAt);
    if (!E.decoded(outer) || !FRAME_IDS.has(outer.id)) continue;
    const blockHead = heldBlockHead(window, outer);
    if (blockHead === null || blockHead.trackNumber !== trackNumber) continue;
    if (cued !== null) return null;
    cued = { blockAt, outer, clusterBody, clusterTicks: ticks - blockHead.relTicks, window };
  }
  return cued;
}

export function agreesWithCluster(
  windows: WindowIndex,
  point: CuePosition,
  cued: CuedBlock,
): boolean {
  const pointed = locateBlock(windows, point, { last: null });
  if (typeof pointed === "string") return false;
  return pointed.blockAt === cued.blockAt && pointed.clusterTicks === cued.clusterTicks;
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

async function frameOfBlock(
  windows: WindowIndex,
  outer: Element,
  clusterTicks: number,
  held: Window,
  trackNumber: number,
  claim: FrameClaim,
): Promise<BlockFrame | BlockClause> {
  const claims = new Map([[trackNumber, claim]]);
  const supply: BytesSupply = (at, need) => {
    const window = windows.find(at, need);
    if (window === null) throw new E.GrammarError();
    return Promise.resolve(window);
  };
  try {
    const frame = await frameIn(outer, clusterTicks, held, claims, supply);
    return frame ?? BLOCK_REFUSAL.notThisTrack;
  } catch (error) {
    if (!E.isGrammarError(error)) throw error;
    return BLOCK_REFUSAL.notFetched;
  }
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
  if (relPos >= cluster.size) return BLOCK_REFUSAL.pastTheCluster;

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
