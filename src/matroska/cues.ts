import type { Element, Window } from "../ebml.js";
import * as E from "../ebml.js";
import type { Range } from "../io/source.js";
import type { WindowIndex } from "../io/windows.js";
import {
  BLOCK_REFUSAL,
  type BlockClause,
  type BytesSupply,
  type ClaimedFrame,
  type ClaimOf,
  type FrameClaim,
  frameIn,
  heldBlockHead,
} from "./block.js";
import {
  CLUSTER_PROBE_BYTES,
  ELEMENT_HEADER_BYTES,
  FRAME_IDS,
  headerNeed,
  readClusterTime,
} from "./chain.js";
import type { CuePosition } from "./header.js";

/**
 * The cluster the previous point named.
 *
 * Points naming the same cluster in a row share its element, its time and the last window.
 */
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
  clusterTime: number | null;
  window: Window;
}

export async function readFrame<C extends FrameClaim>(
  windows: WindowIndex,
  point: CuePosition,
  trackNumber: number,
  claim: C,
  memo: ClusterMemo = { last: null },
): Promise<ClaimedFrame<C> | BlockClause> {
  const pointed = locateBlock(windows, point, memo);
  if (typeof pointed === "string") return pointed;
  const { clusterTime, window, outer } = pointed;

  if (clusterTime === null) return BLOCK_REFUSAL.noClusterTime;

  return frameOfBlock(windows, outer, clusterTime, window, trackNumber, claim);
}

export function readCuedFrame<C extends FrameClaim>(
  windows: WindowIndex,
  cued: CuedBlock,
  trackNumber: number,
  claim: C,
): Promise<ClaimedFrame<C> | BlockClause> {
  const { outer, clusterTicks, window } = cued;
  return frameOfBlock(windows, outer, clusterTicks, window, trackNumber, claim);
}

export function planRanges(points: readonly CuePosition[], cueAheadBytes: number): Range[] {
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
    const rest = restOfBlock(windows, blockAt, outer);
    if (rest !== null) ranges.push(rest);
  }
  return ranges;
}

export function planCuedShortfall(windows: WindowIndex, blocks: Iterable<CuedBlock>): Range[] {
  const ranges: Range[] = [];
  for (const { blockAt, outer } of blocks) {
    const rest = restOfBlock(windows, blockAt, outer);
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
  let found: CuedBlock | null = null;
  for (let width = MIN_CLUSTER_HEADER_BYTES; width <= MAX_CLUSTER_HEADER_BYTES; width++) {
    const clusterBody = clusterPos + width;
    const blockAt = clusterBody + relPos;
    const outer = E.readElement(window, blockAt);
    if (!E.decoded(outer) || !FRAME_IDS.has(outer.id)) continue;
    const head = heldBlockHead(window, outer);
    if (head === null || head.trackNumber !== trackNumber) continue;
    if (found !== null) return null;
    found = { blockAt, outer, clusterBody, clusterTicks: ticks - head.relTicks, window };
  }
  return found;
}

/** Whether the cluster's own head places and dates the block as its cue did. */
export function agreesWithCluster(
  windows: WindowIndex,
  point: CuePosition,
  cued: CuedBlock,
): boolean {
  const memo: ClusterMemo = { last: null };
  const pointed = locateBlock(windows, point, memo);
  if (typeof pointed === "string") return false;
  return pointed.blockAt === cued.blockAt && pointed.clusterTime === cued.clusterTicks;
}

interface PointedBlock {
  clusterTime: number | null;
  window: Window;
  blockAt: number;
  outer: Element;
}

const CLUSTER_ID_BYTES = 4;

const MIN_CLUSTER_HEADER_BYTES = CLUSTER_ID_BYTES + 1;

const MAX_CLUSTER_HEADER_BYTES = CLUSTER_ID_BYTES + E.MAX_VINT_BYTES;

const restOfBlock = (windows: WindowIndex, blockAt: number, outer: Element): Range | null =>
  windows.find(blockAt, outer.next - blockAt) === null
    ? { at: blockAt, length: outer.next - blockAt }
    : null;

async function frameOfBlock<C extends FrameClaim>(
  windows: WindowIndex,
  outer: Element,
  clusterTicks: number,
  held: Window,
  trackNumber: number,
  claim: C,
): Promise<ClaimedFrame<C> | BlockClause> {
  const claimOf: ClaimOf<C> = (number) => (number === trackNumber ? claim : null);
  const supply: BytesSupply = (at, need) => {
    const window = windows.find(at, need);
    if (window === null) throw new E.GrammarError();
    return Promise.resolve(window);
  };
  try {
    const read = await frameIn(outer, clusterTicks, held, claimOf, supply);
    return read ?? BLOCK_REFUSAL.notThisTrack;
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
    const head = windows.find(clusterPos, ELEMENT_HEADER_BYTES);
    if (head === null) return BLOCK_REFUSAL.notFetched;
    const cluster = E.readElement(head, clusterPos);
    if (typeof cluster === "string" || cluster.id !== E.ID.segment.CLUSTER) {
      return BLOCK_REFUSAL.notACluster;
    }
    if ("open" in cluster) return BLOCK_REFUSAL.openCluster;
    const clusterTime = readClusterTime(head, cluster);
    last = { clusterPos, cluster, clusterTime, window: head };
    memo.last = last;
  }
  const { cluster, clusterTime } = last;
  if (relPos >= cluster.size) return BLOCK_REFUSAL.pastTheCluster;

  const blockAt = cluster.body + relPos;
  const bound = headerNeed(blockAt, cluster.next);
  const held = last.window;
  const window = E.covers(held, blockAt, bound) ? held : windows.find(blockAt, bound);
  if (window === null) return BLOCK_REFUSAL.notFetched;
  last.window = window;

  const outer = E.readElement(window, blockAt);
  if (!E.fits(outer, cluster.next)) return BLOCK_REFUSAL.runsPastCluster;
  if (!FRAME_IDS.has(outer.id)) return BLOCK_REFUSAL.notABlock;
  return { clusterTime, window, blockAt, outer };
}
