/**
 * The plumbing of windows.
 *
 * Makes windows from a source, indexes them, and reuses them.
 */

import type { Window } from "../ebml.js";
import * as E from "../ebml.js";
import { inParallel } from "./lanes.js";
import {
  available,
  type IndexFetch,
  LARGE_READ_BYTES,
  MAX_SPAN_BYTES,
  type Range,
  type SizedSource,
  type Source,
  stopIfAborted,
} from "./source.js";

/** The window buffers the walk reuses. */
export interface WindowPool {
  /**
   * A lease when the width fits the threshold and a slot.
   *
   * Otherwise null, which is the fresh-allocation path.
   */
  borrow(width: number): Lease | null;
}

/**
 * The lease of one slot.
 *
 * `release` is one-shot; a second call throws.
 */
interface Lease {
  readonly bytes: Uint8Array;
  release: () => void;
}

export class WindowIndex {
  readonly #sorted: Window[];
  readonly #widestSorted: number;
  readonly #head: Window | undefined;

  constructor(windows: readonly Window[], head?: Window) {
    this.#sorted = [...windows].sort((a, b) => a.at - b.at);
    this.#widestSorted = this.#sorted.reduce((max, w) => Math.max(max, w.bytes.length), 0);
    this.#head = head;
  }

  find(at: number, length: number): Window | null {
    let low = 0;
    let high = this.#sorted.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((this.#sorted[mid] as Window).at <= at) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    let best = this.#head !== undefined && E.covers(this.#head, at, length) ? this.#head : null;
    for (let i = low - 1; i >= 0; i--) {
      const window = this.#sorted[i] as Window;
      if (at - window.at > this.#widestSorted) break;
      if (!E.covers(window, at, length)) continue;
      if (best === null || E.reachOf(window) > E.reachOf(best)) {
        best = window;
      }
    }
    return best;
  }
}

export async function fetchRanges(
  sized: SizedSource,
  ranges: readonly Range[],
  knobs: Pick<IndexFetch, "gapBytes" | "concurrency">,
  signal?: AbortSignal,
): Promise<Window[]> {
  const spans = coalesceAcross(ranges, [], knobs);
  return fetchSpans(sized, spans, knobs.concurrency, signal);
}

export async function fetchSpans(
  sized: SizedSource,
  spans: readonly Range[],
  concurrency: number,
  signal?: AbortSignal,
): Promise<Window[]> {
  const windowFor = (span: Range) => windowAt(sized, span.at, span.length, signal);
  return inParallel(spans, concurrency, windowFor, signal);
}

/** The spans that read every wanted range, letting a stone close the hole between two of them. */
export function coalesceAcross(
  wanted: readonly Range[],
  stones: readonly Range[],
  knobs: Pick<IndexFetch, "gapBytes">,
): Range[] {
  const from = wanted.reduce((least, range) => Math.min(least, range.at), Number.POSITIVE_INFINITY);
  const furthest = (most: number, range: Range) => Math.max(most, range.at + range.length);
  const to = wanted.reduce(furthest, Number.NEGATIVE_INFINITY) + knobs.gapBytes;
  const near = stones.filter((stone) => stone.at >= from && stone.at <= to);
  const marked: MarkedRange[] = [
    ...wanted.map((range) => ({ range, isWanted: true })),
    ...near.map((range) => ({ range, isWanted: false })),
  ].sort((a, b) => a.range.at - b.range.at);
  const spans: Range[] = [];
  for (const group of coalesced(marked, knobs)) {
    const first = group.findIndex(({ isWanted }) => isWanted);
    if (first < 0) continue;
    const lastWanted = group.map(({ isWanted }) => isWanted).lastIndexOf(true);
    const lastAt = (group[lastWanted] as MarkedRange).range.at;
    const keptEnd = group.map(({ range }) => range.at <= lastAt).lastIndexOf(true) + 2;
    const kept = group.slice(first, keptEnd);
    const at = (kept[0] as MarkedRange).range.at;
    const through = kept.reduce((most, { range }) => furthest(most, range), at);
    spans.push({ at, length: through - at });
  }
  return spans;
}

export function windowPool(slotBytes: number, slots: number): WindowPool {
  const free: Uint8Array[] = [];
  let unbuilt = slotBytes >= LARGE_READ_BYTES ? slots : 0;
  const lease = (slot: Uint8Array, width: number): Lease => {
    let released = false;
    const release = () => {
      if (released) throw new Error();
      released = true;
      free.push(slot);
    };
    return { bytes: slot.subarray(0, width), release };
  };
  const borrow = (width: number) => {
    if (width < LARGE_READ_BYTES || width > slotBytes) return null;
    let slot = free.pop() ?? null;
    if (slot === null && unbuilt > 0) {
      unbuilt -= 1;
      const owned = new ArrayBuffer(slotBytes);
      slot = new Uint8Array(owned);
    }
    return slot === null ? null : lease(slot, width);
  };
  return { borrow };
}

export async function windowOver(
  source: Source,
  at: number,
  length: number,
  held: Window,
  signal: AbortSignal | undefined,
): Promise<Window> {
  const need = available(at, length, held.fileSize);
  if (E.covers(held, at, need)) return held;
  const sized = { source, fileSize: held.fileSize };
  return windowAt(sized, at, length, signal);
}

/** The one place a `Source` is read. */
export async function windowAt(
  { source, fileSize }: SizedSource,
  at: number,
  length: number,
  signal: AbortSignal | undefined,
  into?: Uint8Array,
): Promise<Window> {
  stopIfAborted(signal);
  const answer: unknown = await source.read(at, length, into, signal);
  const isBytes = ArrayBuffer.isView(answer) && (answer as Uint8Array).BYTES_PER_ELEMENT === 1;
  if (!isBytes) throw new Error();
  // Held as a plain Uint8Array, since what is kept from a window is sliced out of it and a Buffer's slice is a view.
  const held = new Uint8Array(answer.buffer, answer.byteOffset, answer.byteLength);
  if (held.length < available(at, length, fileSize)) throw new Error();
  return { at, bytes: held, fileSize };
}

/** A range, and whether the read asked for it or may only cross it. */
interface MarkedRange {
  range: Range;
  isWanted: boolean;
}

/** Sorted ranges grouped so that one read takes each group, within the gap and under the cap. */
function coalesced(
  sorted: readonly MarkedRange[],
  knobs: Pick<IndexFetch, "gapBytes">,
): MarkedRange[][] {
  const groups: MarkedRange[][] = [];
  let start = 0;
  let end = 0;
  for (const marked of sorted) {
    const { at, length } = marked.range;
    const reach = Math.max(end, at + length);
    const last = groups.at(-1);
    if (last !== undefined && at - end <= knobs.gapBytes && reach - start <= MAX_SPAN_BYTES) {
      last.push(marked);
      end = reach;
      continue;
    }
    groups.push([marked]);
    start = at;
    end = at + length;
  }
  return groups;
}
