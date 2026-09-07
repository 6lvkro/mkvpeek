import type { Element, Window } from "../ebml.js";
import * as E from "../ebml.js";
import type { Range } from "../io/source.js";
import type { WindowIndex } from "../io/windows.js";
import {
  BLOCK_REFUSAL,
  type BlockClause,
  type BytesSupply,
  type Frame,
  frameIn,
  type TrackClaim,
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

interface LastCluster {
  clusterPos: number;
  cluster: Element;
  clusterTime: number | null;
  window: Window;
}

export function planRanges(points: readonly CuePosition[], cueAheadBytes: number): Range[] {
  const ranges: Range[] = [];
  const clusters = new Set<number>();
  for (const { clusterPos, relPos } of points) {
    if (!clusters.has(clusterPos)) {
      clusters.add(clusterPos);
      ranges.push({ at: clusterPos, length: CLUSTER_PROBE_BYTES });
    }
    ranges.push({
      at: clusterPos + relPos,
      length: MAX_CLUSTER_HEADER_BYTES + cueAheadBytes,
    });
  }
  return ranges;
}

export function planShortfall(windows: WindowIndex, points: readonly CuePosition[]): Range[] {
  const ranges: Range[] = [];
  const memo: ClusterMemo = { last: null };
  for (const point of points) {
    const pointed = locateBlock(windows, point, memo);
    if (typeof pointed === "string") continue;
    const { window, blockAt, outer } = pointed;
    const covered = E.reachOf(window);
    if (outer.next > covered) {
      ranges.push({ at: blockAt, length: outer.next - blockAt });
    }
  }
  return ranges;
}

export async function readFrame(
  windows: WindowIndex,
  point: CuePosition,
  trackNumber: number,
  numbered: boolean,
  memo: ClusterMemo = { last: null },
): Promise<Frame | BlockClause> {
  const pointed = locateBlock(windows, point, memo);
  if (typeof pointed === "string") return pointed;
  const { clusterTime, window, outer } = pointed;

  if (clusterTime === null) return BLOCK_REFUSAL.noClusterTime;

  const claim: TrackClaim = (track) => (track === trackNumber ? numbered : null);
  const supply: BytesSupply = (at, need) => {
    const window = windows.find(at, need);
    if (window === null) throw new E.GrammarError();
    return Promise.resolve(window);
  };
  try {
    const claimed = await frameIn(outer, clusterTime, window, claim, supply);
    if (claimed === null) return BLOCK_REFUSAL.notThisTrack;
    return typeof claimed === "string" ? claimed : claimed.frame;
  } catch (error) {
    if (!E.isGrammarError(error)) throw error;
    return BLOCK_REFUSAL.notFetched;
  }
}

interface PointedBlock {
  clusterTime: number | null;
  window: Window;
  blockAt: number;
  outer: Element;
}

const MAX_CLUSTER_HEADER_BYTES = 4 + E.MAX_VINT_BYTES;

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
