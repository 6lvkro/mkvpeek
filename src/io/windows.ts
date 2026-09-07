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
  options: Pick<IndexFetch, "gapBytes" | "concurrency">,
  signal?: AbortSignal,
): Promise<Window[]> {
  const spans = coalesce(ranges, options);
  return fetchSpans(sized, spans, options.concurrency, signal);
}

export async function fetchSpans(
  sized: SizedSource,
  spans: readonly Range[],
  concurrency: number,
  signal?: AbortSignal,
): Promise<Window[]> {
  const windowFor = (span: Range) => windowAt(sized, span.at, span.length);
  return inParallel(spans, concurrency, windowFor, signal);
}

export function coalesce(ranges: readonly Range[], options: Pick<IndexFetch, "gapBytes">): Range[] {
  const sorted = [...ranges].filter((r) => r.length > 0).sort((a, b) => a.at - b.at);
  const spans: Range[] = [];
  for (const range of sorted) {
    const last = spans[spans.length - 1];
    if (last === undefined) {
      spans.push({ ...range });
      continue;
    }
    const lastEnd = last.at + last.length;
    const merged = Math.max(lastEnd, range.at + range.length) - last.at;
    if (range.at - lastEnd <= options.gapBytes && merged <= MAX_SPAN_BYTES) {
      last.length = merged;
      continue;
    }
    spans.push({ ...range });
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
    return { bytes: slot.subarray(0, width), release: release };
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
): Promise<Window> {
  const need = available(at, length, held.fileSize);
  if (E.covers(held, at, need)) return held;
  const heldSource = { source, fileSize: held.fileSize };
  return windowAt(heldSource, at, length);
}

export async function windowAt(
  { source, fileSize }: SizedSource,
  at: number,
  length: number,
  into?: Uint8Array,
): Promise<Window> {
  const bytes = await source.read(at, length, into);
  const expected = available(at, length, fileSize);
  if (bytes.length < expected) throw new Error();
  return { at, bytes, fileSize };
}
