import type { Element, OpenElement, Window } from "../ebml.js";
import * as E from "../ebml.js";
import { HaltableQueue, joinOrAbort } from "../io/lanes.js";
import {
  available,
  type SizedSource,
  stopIfAborted,
  type WalkFetch,
  type Watch,
} from "../io/source.js";
import { type WindowPool, windowAt, windowPool } from "../io/windows.js";
import {
  BLOCK_HEAD_BYTES,
  BLOCK_REFUSAL,
  type BlockClause,
  type Frame,
  frameIn,
  type TrackClaim,
} from "./block.js";
import {
  CLUSTER_PROBE_BYTES,
  FRAME_IDS,
  hopTopLevel,
  readClusterTime,
  type SegmentPass,
} from "./chain.js";

export async function walkFrames(
  pass: SegmentPass,
  tracks: ReadonlyMap<number, boolean>,
  knobs: WalkFetch,
  { onProgress, signal }: Watch,
): Promise<Map<number, Frame[]> | null> {
  const fileSize = pass.head.fileSize;
  onProgress(0, fileSize);
  const slotBytes = Math.min(knobs.blockAheadBytes, fileSize);
  const pool = windowPool(slotBytes, knobs.concurrency + 4);
  const sized = { source: pass.source, fileSize };
  const walk: WalkInvariants = { sized, tracks, knobs, head: pass.head };
  let done = 0;
  let refused = false;
  const walked = new Map<number, Map<number, Frame[]>>();
  const record = (
    index: number,
    span: ClusterSpan,
    outcome: SweptFrames | BlockClause,
  ): outcome is SweptFrames => {
    if (typeof outcome === "string") {
      refused = true;
      return false;
    }
    walked.set(index, outcome.frames);
    done += outcome.end - span.at;
    onProgress(done, fileSize);
    return true;
  };

  const queue = new HaltableQueue<QueuedCluster>();
  let count = 0;
  const feed = async (): Promise<void> => {
    // the window the previous open walk was carrying
    let seed: Loaned | undefined;
    try {
      let pos = pass.segment.body;
      while (!queue.halted) {
        let openCluster: QueuedCluster | null = null;
        for await (const { at, el, window } of hopTopLevel(pass, pos)) {
          if (queue.halted) return;
          if (!TOP_LEVEL_IDS.has(el.id)) {
            refused = true;
            queue.halt();
            return;
          }
          if (el.id !== E.ID.segment.CLUSTER) continue;
          if ("open" in el) {
            openCluster = { index: count++, span: { at, el, end: pass.segment.end }, window };
            break;
          }
          const queued = { index: count++, span: { at, el, end: el.next }, window };
          queue.push(queued);
        }
        if (openCluster === null) break;
        const outcome = await walkCluster(walk, openCluster.span, pool, seed ?? openCluster.window);
        if (!record(openCluster.index, openCluster.span, outcome)) {
          queue.halt();
          return;
        }
        if (seed !== undefined && outcome.carried !== seed) seed.release?.();
        seed = outcome.carried;
        pos = outcome.end;
      }
    } catch (error) {
      // Only grammar is swallowed;
      // swallowing a source failure too would make it a verdict on the container.
      queue.halt();
      if (!E.isGrammarError(error)) throw error;
      refused = true;
    } finally {
      // close first, since release is a call that can throw.
      queue.close();
      seed?.release?.();
    }
  };

  const eachCluster = async (item: QueuedCluster) => {
    const outcome = await walkCluster(walk, item.span, pool, item.window);
    const kept = record(item.index, item.span, outcome);
    if (kept) outcome.carried.release?.();
    return kept;
  };
  const feeding = feed();
  if (knobs.concurrency < 2) {
    await feeding.then(
      () => {},
      () => {},
    );
  }
  const laneCount = Math.max(1, knobs.concurrency - 1);
  const draining = queue.drain(laneCount, eachCluster, signal);
  await joinOrAbort([feeding, draining], signal);

  stopIfAborted(signal);
  if (refused || count === 0) return null;
  onProgress(fileSize, fileSize);
  return merged(walked);
}

/** The invariants of one walk. */
interface WalkInvariants {
  sized: SizedSource;
  tracks: ReadonlyMap<number, boolean>;
  knobs: WalkFetch;
  head: Window;
}

/**
 * A cluster span as the hop measured it.
 *
 * For a cluster without a size, `end` is where the walk has to stop (the end of the Segment).
 */
interface ClusterSpan {
  at: number;
  el: Element | OpenElement;
  end: number;
}

type SweptFrames = {
  frames: Map<number, Frame[]>;
  end: number;
};

type WalkedCluster = (SweptFrames & { carried: Loaned }) | BlockClause;

/**
 * A cluster the hop measured and put in the worker queue.
 *
 * The window is the one the hop read the head from, so it becomes the walk's first probe.
 */
interface QueuedCluster {
  index: number;
  span: ClusterSpan;
  window: Window;
}

interface Loans {
  pool: WindowPool;
  ledger: Set<Loaned>;
}

type Loaned = Window & { readonly release?: () => void };

const CLUSTER_CHILD_IDS = new Set<number>([
  ...Object.values(E.ID.cluster),
  ...Object.values(E.ID.global),
]);

const CLUSTER_END_IDS = new Set<number>(Object.values(E.ID.segment));

/**
 * Every child of the Segment plus the two globals.
 *
 * The hop dies on any id outside this set.
 */
const TOP_LEVEL_IDS = new Set<number>([...CLUSTER_END_IDS, ...Object.values(E.ID.global)]);

/** A BlockGroup child sitting directly under the cluster is a stray block. */
const STRAY_IDS = new Set<number>(Object.values(E.ID.blockGroup));

async function walkCluster(
  walk: WalkInvariants,
  span: ClusterSpan,
  pool: WindowPool,
  seed?: Loaned,
): Promise<WalkedCluster> {
  const ledger = new Set<Loaned>();
  let outcome: WalkedCluster;
  try {
    const loans = { pool, ledger };
    outcome = await walkSpan(walk, span, loans, seed);
  } catch (error) {
    releaseAll(ledger, true);
    throw error;
  }
  if (typeof outcome !== "string") ledger.delete(outcome.carried);
  releaseAll(ledger, false);
  return outcome;
}

function releaseAll(ledger: Set<Loaned>, swallow: boolean): void {
  let first: unknown = null;
  for (const window of ledger) {
    try {
      window.release?.();
    } catch (error) {
      first ??= error;
    }
  }
  if (first !== null && !swallow) throw first;
}

async function walkSpan(
  { sized, tracks, knobs, head }: WalkInvariants,
  span: ClusterSpan,
  { pool, ledger }: Loans,
  seed?: Loaned,
): Promise<WalkedCluster> {
  const widthFor = (at: number, need: number) => {
    if (knobs.blockAheadBytes === 0) return need;
    const bound = Math.min(knobs.blockAheadBytes, span.end - at);
    return Math.max(need, bound);
  };
  const first = widthFor(span.at, CLUSTER_PROBE_BYTES);
  const fetchWindow = async (at: number, width: number) => {
    const bounded = available(at, width, sized.fileSize);
    if (E.covers(head, at, bounded)) return head;
    const lease = pool.borrow(width);
    if (lease === null) return windowAt(sized, at, width);
    let window: Window;
    try {
      window = await windowAt(sized, at, width, lease.bytes);
    } catch (error) {
      lease.release();
      throw error;
    }
    if (window.bytes.buffer !== lease.bytes.buffer) {
      lease.release();
      return window;
    }
    const owned = { ...window, release: lease.release };
    ledger.add(owned);
    return owned;
  };
  const seeded = available(span.at, first, sized.fileSize);
  const adopted = seed !== undefined && E.covers(seed, span.at, seeded) ? seed : null;
  let carried: Window = adopted ?? (await fetchWindow(span.at, first));
  const clusterTime = readClusterTime(carried, span.el);
  if (clusterTime === null) return BLOCK_REFUSAL.noClusterTime;

  const frames = new Map<number, Frame[]>();
  let pos = span.el.body;
  const supply = async (at: number, need: number) => {
    if (E.covers(carried, at, need)) return carried;
    const width = widthFor(at, need);
    const window = await fetchWindow(at, width);
    if (E.reachOf(window) > E.reachOf(carried)) {
      carried = window;
    }
    return window;
  };
  const claim: TrackClaim = (track) => tracks.get(track) ?? null;
  while (pos < span.end) {
    const need = Math.min(BLOCK_HEAD_BYTES, span.end - pos);
    const window = await supply(pos, need);
    const el = E.readElement(window, pos);
    if (typeof el === "string") return BLOCK_REFUSAL.notAnElement;
    if ("open" in el) {
      if ("open" in span.el) return { frames, end: pos, carried };
      return BLOCK_REFUSAL.runsPastCluster;
    }
    if (STRAY_IDS.has(el.id)) return BLOCK_REFUSAL.strayBlock;
    if (!CLUSTER_CHILD_IDS.has(el.id)) {
      if ("open" in span.el && CLUSTER_END_IDS.has(el.id)) return { frames, end: pos, carried };
      return BLOCK_REFUSAL.stranger;
    }
    if (el.next > span.end) return BLOCK_REFUSAL.runsPastCluster;
    if (FRAME_IDS.has(el.id)) {
      const attributed = await frameIn(el, clusterTime, window, claim, supply);
      if (typeof attributed === "string") return attributed;
      if (attributed !== null) {
        const list = frames.get(attributed.track);
        if (list === undefined) frames.set(attributed.track, [attributed.frame]);
        else list.push(attributed.frame);
      }
    }
    pos = el.next;
  }
  return { frames, end: span.end, carried };
}

function merged(walked: Map<number, Map<number, Frame[]>>): Map<number, Frame[]> {
  const chunks = new Map<number, Frame[][]>();
  const sorted = [...walked.entries()].sort(([a], [b]) => a - b);
  for (const [, found] of sorted) {
    for (const [track, frames] of found) {
      const list = chunks.get(track);
      if (list === undefined) chunks.set(track, [frames]);
      else list.push(frames);
    }
  }
  const flattened = [...chunks].map(([track, lists]): [number, Frame[]] => [track, lists.flat()]);
  return new Map(flattened);
}
