import type { Element, Window } from "../ebml.js";
import * as E from "../ebml.js";
import type { Range } from "../io/source.js";
import type { Undo } from "./encoding.js";
import { ID } from "./ids.js";

/** How a chosen track's frames are undone. */
export interface FrameClaim {
  undo: Undo | null;
}

/** A block's frame, under the TrackNumber its head states. */
export interface BlockFrame {
  trackNumber: number;
  startTicks: number;
  durationTicks: number | null;
  payload: Uint8Array;
}

export interface StoredFrame {
  trackNumber: number;
  startTicks: number;
  durationTicks: number | null;
  stored: Uint8Array;
  undo: Undo | null;
}

export type BlockRefusal = "malformed" | "unreadable";

export const BLOCK_PROBE_BYTES = 32;

export const FRAME_IDS: ReadonlySet<number> = new Set([
  ID.cluster.SIMPLE_BLOCK,
  ID.cluster.BLOCK_GROUP,
]);

/**
 * One frame of a block element as stored, null for a track `claims` does not hold, and why where it is not read.
 *
 * Each range it yields must be answered with a window that holds it.
 */
export function* blockSteps(
  outer: Element,
  clusterTicks: number,
  held: Window,
  claims: ReadonlyMap<number, FrameClaim>,
): Generator<Range, StoredFrame | null | BlockRefusal, Window> {
  let window = held;
  let body = outer.body;
  let size = outer.size;
  let durationTicks: number | null = null;
  if (outer.id === ID.cluster.BLOCK_GROUP) {
    const probeBytes = Math.min(outer.size, BLOCK_GROUP_PROBE_BYTES);
    if (!E.covers(window, outer.body, probeBytes)) {
      window = yield { at: outer.body, length: probeBytes };
    }
    const field = E.elementCursor();
    let innerBody = -1;
    let innerSize = 0;
    let pos = outer.body;
    while (pos < outer.next) {
      const need = E.headerNeed(pos, outer.next);
      if (!E.covers(window, pos, need)) {
        window = yield { at: pos, length: need };
      }
      const fits = E.readElementInto(window, pos, field) && !field.open && field.next <= outer.next;
      if (!fits) return "malformed";
      if (field.id === ID.blockGroup.BLOCK) {
        innerBody = field.body;
        innerSize = field.size;
      } else if (field.id === ID.blockGroup.BLOCK_DURATION) {
        if (E.uintFits(field.size)) {
          if (!E.covers(window, field.body, field.size)) {
            window = yield { at: field.body, length: field.size };
          }
          durationTicks = E.readUintAt(window, field.body, field.size);
        }
      }
      pos = field.next;
    }
    if (innerBody < 0) return "malformed";
    body = innerBody;
    size = innerSize;
  }
  const headNeed = headBytes(size);
  if (!E.covers(window, body, headNeed)) {
    window = yield { at: body, length: headNeed };
  }
  const head = trackOfBlock(window, body, size);
  if (head === "undecodable") return "malformed";
  const { trackNumber, numberBytes } = HEAD;
  const claim = claims.get(trackNumber);
  if (claim === undefined) return null;
  if (head === "cut") return "malformed";
  const start = body + numberBytes - window.at;
  if (((window.bytes[start + 2] as number) & LACING_MASK) !== 0) return "unreadable";
  const payloadAt = body + numberBytes + TIME_AND_FLAGS_BYTES;
  const payloadSize = size - (numberBytes + TIME_AND_FLAGS_BYTES);
  const covering = E.covers(window, payloadAt, payloadSize)
    ? window
    : yield { at: payloadAt, length: payloadSize };
  const stored = E.readBytes(covering, payloadAt, payloadSize);
  const startTicks = clusterTicks + relTicksAt(window.bytes, start);
  return { trackNumber, startTicks, durationTicks, stored, undo: claim.undo };
}

export function plainFrame(frame: StoredFrame): BlockFrame {
  const { trackNumber, startTicks, durationTicks, stored } = frame;
  const payload = stored.slice();
  return { trackNumber, startTicks, durationTicks, payload };
}

export async function undoneFrame(
  frame: StoredFrame,
  undo: Undo,
): Promise<BlockFrame | BlockRefusal> {
  const { trackNumber, startTicks, durationTicks, stored } = frame;
  const undoing = undo(stored);
  let payload: Uint8Array;
  try {
    payload = await undoing;
  } catch {
    // An inflation past the bound and bytes after the stream are refused too, so a broken spec is not told apart.
    return "unreadable";
  }
  return { trackNumber, startTicks, durationTicks, payload };
}

export function relTicksIfTrack(
  window: Window,
  outer: E.ElementCursor,
  trackNumber: number,
): number | null {
  let body = outer.body;
  let size = outer.size;
  if (outer.id === ID.cluster.BLOCK_GROUP) {
    const fits =
      E.readElementInto(window, outer.body, INNER) && !INNER.open && INNER.next <= outer.next;
    if (!fits || INNER.id !== ID.blockGroup.BLOCK) return null;
    body = INNER.body;
    size = INNER.size;
  }
  const need = headBytes(size);
  if (!E.covers(window, body, need) || trackOfBlock(window, body, size) !== "whole") return null;
  if (HEAD.trackNumber !== trackNumber) return null;
  return relTicksAt(window.bytes, body + HEAD.numberBytes - window.at);
}

/** Whether the window alone shows a SimpleBlock of a track not chosen, which blockSteps would answer null. */
export function skipsUnclaimed(
  window: Window,
  el: E.ElementCursor,
  claims: ReadonlyMap<number, FrameClaim>,
): boolean {
  if (el.id !== ID.cluster.SIMPLE_BLOCK) return false;
  const need = headBytes(el.size);
  if (!E.covers(window, el.body, need)) return false;
  return trackOfBlock(window, el.body, el.size) !== "undecodable" && !claims.has(HEAD.trackNumber);
}

const TIME_AND_FLAGS_BYTES = 3;

const MAX_BLOCK_HEAD_BYTES = E.MAX_VINT_BYTES + TIME_AND_FLAGS_BYTES;

const BLOCK_GROUP_PROBE_BYTES = 256;

const LACING_MASK = 0x06;

// What reads into these two is synchronous, so reusing them mixes no reads.
const HEAD = { trackNumber: 0, numberBytes: 0 };

const INNER = E.elementCursor();

// On the browser bundle's path, so `Buffer.readInt16BE` is not available.
const relTicksAt = (bytes: Uint8Array, start: number): number =>
  ((((bytes[start] as number) << 8) | (bytes[start + 1] as number)) << 16) >> 16;

const headBytes = (size: number): number => Math.min(MAX_BLOCK_HEAD_BYTES, size);

/**
 * Reads the TrackNumber of a block whose headBytes(size) the window covers, and its width, into HEAD.
 *
 * "undecodable" where the TrackNumber does not decode inside the block, "cut" where the block cannot hold its time and flags.
 */
function trackOfBlock(window: Window, body: number, size: number): "undecodable" | "cut" | "whole" {
  const numberBytes = E.vintLengthAt(window, body);
  if (numberBytes === 0 || numberBytes > size) return "undecodable";
  HEAD.trackNumber = E.sizeVintAt(window, body, numberBytes);
  HEAD.numberBytes = numberBytes;
  return numberBytes + TIME_AND_FLAGS_BYTES > size ? "cut" : "whole";
}
