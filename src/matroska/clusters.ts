import type { Element, OpenElement, Window } from "../ebml.js";
import * as E from "../ebml.js";
import { HaltableQueue, joinOrAbort } from "../io/lanes.js";
import {
  available,
  linkedSignal,
  type SizedSource,
  stopIfAborted,
  type WalkFetch,
  type Watch,
} from "../io/source.js";
import { type WindowPool, windowAt, windowPool } from "../io/windows.js";
import {
  BLOCK_PROBE_BYTES,
  BLOCK_REFUSAL,
  type BlockClause,
  type ClaimedFrame,
  type ClaimOf,
  type FrameClaim,
  frameIn,
} from "./block.js";
import {
  CLUSTER_PROBE_BYTES,
  FRAME_IDS,
  hopTopLevel,
  readClusterTicks,
  type SegmentPass,
} from "./chain.js";

/**
 * Hands over the claimed tracks' frames cluster by cluster, in file order.
 *
 * A refusal is a `GrammarError` after the clusters before it, and ending the iteration ends the reads.
 */
export async function* walkFrames<C extends FrameClaim>(
  opened: Omit<SegmentPass, "signal">,
  claims: ReadonlyMap<number, C>,
  knobs: WalkFetch,
  watch: Watch,
): AsyncGenerator<ClaimedFrame<C>[]> {
  const fileSize = opened.head.fileSize;
  watch.onProgress(0, fileSize);
  const ended = new AbortController();
  // The link stops listening once either signal fires, and `ended` fires as the walk ends.
  const { signal } = linkedSignal(watch.signal, ended.signal);
  const reading = { ...opened, signal };
  const slotBytes = Math.min(knobs.blockAheadBytes, fileSize);
  const pool = windowPool(slotBytes, knobs.concurrency + 4);
  const sized = { source: opened.source, fileSize };
  const walk: WalkInvariants<C> = { sized, claims, knobs, head: opened.head, signal };
  // The hop takes one of the reads; with none to spare for a lane, it walks what it finds.
  const laneCount = knobs.concurrency - 1;
  const ahead = Math.max(1, laneCount) * CLUSTERS_AHEAD_PER_LANE;
  const walked = new Map<number, ClaimedFrame<C>[]>();
  let doneBytes = 0;
  let foundCount = 0;
  let handedCount = 0;
  let refused = false;
  let parked: Array<() => void> = [];
  const wake = () => {
    for (const resolve of parked) resolve();
    parked = [];
  };
  const park = () =>
    new Promise<void>((resolve) => {
      parked.push(resolve);
    });
  const queue = new HaltableQueue<HoppedCluster>(wake);
  /** Waits until the cluster at `index` may be found; false once the walk has halted. */
  const admitted = async (index: number) => {
    while (!queue.halted && index - handedCount >= ahead) {
      await park();
      stopIfAborted(signal);
    }
    return !queue.halted;
  };
  const record = (
    index: number,
    span: ClusterSpan,
    outcome: SweptFrames<C> | BlockClause,
  ): outcome is SweptFrames<C> => {
    stopIfAborted(signal);
    wake();
    if (typeof outcome === "string") {
      refused = true;
      return false;
    }
    walked.set(index, outcome.frames);
    doneBytes += outcome.end - span.at;
    watch.onProgress(doneBytes, fileSize);
    return true;
  };

  const walkAndRecord = async (item: HoppedCluster) => {
    const outcome = await walkCluster(walk, item.span, pool, item.window);
    const kept = record(item.index, item.span, outcome);
    if (kept) outcome.carried.release?.();
    return kept;
  };
  const feed = async (): Promise<void> => {
    // the window the previous open walk was carrying
    let seed: Loaned | undefined;
    try {
      let pos = opened.segment.body;
      while (await admitted(foundCount)) {
        let openCluster: HoppedCluster | null = null;
        for await (const { at, el, window } of hopTopLevel(reading, pos)) {
          if (!TOP_LEVEL_IDS.has(el.id)) {
            refused = true;
            queue.halt();
            return;
          }
          if (el.id === E.ID.segment.CLUSTER) {
            if ("open" in el) {
              openCluster = {
                index: foundCount++,
                span: { at, el, end: opened.segment.end },
                window,
              };
              break;
            }
            const sizedCluster = { index: foundCount++, span: { at, el, end: el.next }, window };
            if (laneCount > 0) {
              queue.push(sizedCluster);
            } else if (!(await walkAndRecord(sizedCluster))) {
              return;
            }
          }
          if (!(await admitted(foundCount))) return;
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
      wake();
    }
  };

  const feeding = feed();
  const draining = queue.drain(laneCount, walkAndRecord, signal);
  let finished = false;
  const failures: unknown[] = [];
  const settled = joinOrAbort([feeding, draining], signal).then(
    () => {
      finished = true;
      wake();
    },
    (error: unknown) => {
      failures.push(error);
      finished = true;
      wake();
    },
  );
  try {
    for (;;) {
      const frames = walked.get(handedCount);
      if (frames !== undefined) {
        walked.delete(handedCount);
        handedCount += 1;
        wake();
        if (frames.length > 0) yield frames;
        continue;
      }
      if (finished) break;
      await park();
    }
    if (failures.length > 0) throw failures[0];
    if (refused) throw new E.GrammarError();
    watch.onProgress(fileSize, fileSize);
    stopIfAborted(watch.signal);
  } finally {
    ended.abort();
    queue.halt();
    await settled;
  }
}

/** The invariants of one walk. */
interface WalkInvariants<C extends FrameClaim> {
  sized: SizedSource;
  claims: ReadonlyMap<number, C>;
  knobs: WalkFetch;
  head: Window;
  signal: AbortSignal;
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

interface SweptFrames<C extends FrameClaim> {
  frames: ClaimedFrame<C>[];
  end: number;
}

type WalkedCluster<C extends FrameClaim> = (SweptFrames<C> & { carried: Loaned }) | BlockClause;

/**
 * A cluster the hop measured and put in the worker queue.
 *
 * The window is the one the hop read the head from, so it becomes the walk's first probe.
 */
interface HoppedCluster {
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

const SEGMENT_CHILD_IDS = new Set<number>(Object.values(E.ID.segment));

/**
 * Every child of the Segment plus the two globals.
 *
 * The hop dies on any id outside this set.
 */
const TOP_LEVEL_IDS = new Set<number>([...SEGMENT_CHILD_IDS, ...Object.values(E.ID.global)]);

/** How many clusters per lane the walk may find ahead of the one it hands over next. */
const CLUSTERS_AHEAD_PER_LANE = 4;

/** A BlockGroup child sitting directly under the cluster is a stray block. */
const STRAY_IDS = new Set<number>(Object.values(E.ID.blockGroup));

async function walkCluster<C extends FrameClaim>(
  walk: WalkInvariants<C>,
  span: ClusterSpan,
  pool: WindowPool,
  seed?: Loaned,
): Promise<WalkedCluster<C>> {
  const ledger = new Set<Loaned>();
  let outcome: WalkedCluster<C>;
  try {
    outcome = await walkSpan(walk, span, { pool, ledger }, seed);
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

async function walkSpan<C extends FrameClaim>(
  { sized, claims, knobs, head, signal }: WalkInvariants<C>,
  span: ClusterSpan,
  { pool, ledger }: Loans,
  seed?: Loaned,
): Promise<WalkedCluster<C>> {
  const widthFor = (at: number, need: number) => {
    if (knobs.blockAheadBytes === 0) return need;
    const bound = Math.min(knobs.blockAheadBytes, span.end - at);
    return Math.max(need, bound);
  };
  const firstWidth = widthFor(span.at, CLUSTER_PROBE_BYTES);
  const fetchWindow = async (at: number, width: number) => {
    const bounded = available(at, width, sized.fileSize);
    if (E.covers(head, at, bounded)) return head;
    const lease = pool.borrow(width);
    if (lease === null) return windowAt(sized, at, width, signal);
    let window: Window;
    try {
      window = await windowAt(sized, at, width, signal, lease.bytes);
    } catch (error) {
      lease.release();
      throw error;
    }
    if (window.bytes.buffer !== lease.bytes.buffer) {
      lease.release();
      return window;
    }
    const loaned = { ...window, release: lease.release };
    ledger.add(loaned);
    return loaned;
  };
  const firstBounded = available(span.at, firstWidth, sized.fileSize);
  const adopted = seed !== undefined && E.covers(seed, span.at, firstBounded) ? seed : null;
  let carried: Window = adopted ?? (await fetchWindow(span.at, firstWidth));
  const clusterTicks = readClusterTicks(carried, span.el);
  if (clusterTicks === null) return BLOCK_REFUSAL.noClusterTime;

  const frames: ClaimedFrame<C>[] = [];
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
  const claimOf: ClaimOf<C> = (trackNumber) => claims.get(trackNumber) ?? null;
  while (pos < span.end) {
    const need = Math.min(BLOCK_PROBE_BYTES, span.end - pos);
    const window = await supply(pos, need);
    const el = E.readElement(window, pos);
    if (typeof el === "string") return BLOCK_REFUSAL.notAnElement;
    if ("open" in el) {
      if ("open" in span.el) return { frames, end: pos, carried };
      return BLOCK_REFUSAL.runsPastCluster;
    }
    if (STRAY_IDS.has(el.id)) return BLOCK_REFUSAL.strayBlock;
    if (!CLUSTER_CHILD_IDS.has(el.id)) {
      if ("open" in span.el && SEGMENT_CHILD_IDS.has(el.id)) return { frames, end: pos, carried };
      return BLOCK_REFUSAL.stranger;
    }
    if (el.next > span.end) return BLOCK_REFUSAL.runsPastCluster;
    if (FRAME_IDS.has(el.id)) {
      const claimed = await frameIn(el, clusterTicks, window, claimOf, supply);
      if (typeof claimed === "string") return claimed;
      if (claimed !== null) frames.push(claimed);
    }
    pos = el.next;
  }
  return { frames, end: span.end, carried };
}
