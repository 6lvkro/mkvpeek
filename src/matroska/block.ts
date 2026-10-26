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

/** A block's frame as the file stores it, with the undo its track's claim names. */
export interface StoredFrame {
  trackNumber: number;
  startTicks: number;
  durationTicks: number | null;
  stored: Uint8Array;
  undo: Undo | null;
}

export type BlockRefusal = "malformed" | "unreadable";

interface BlockHead {
  trackNumber: number;
  relTicks: number;
}

interface BlockTrack {
  trackNumber: number;
  numberBytes: number;
  cut: boolean;
}

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
    let inner: Element | null = null;
    let pos = outer.body;
    while (pos < outer.next) {
      const need = E.headerNeed(pos, outer.next);
      if (!E.covers(window, pos, need)) {
        window = yield { at: pos, length: need };
      }
      const field = E.readElement(window, pos);
      if (!E.fits(field, outer.next)) return "malformed";
      if (field.id === ID.blockGroup.BLOCK) {
        inner = field;
      } else if (field.id === ID.blockGroup.BLOCK_DURATION) {
        if (E.uintFits(field.size)) {
          if (!E.covers(window, field.body, field.size)) {
            window = yield { at: field.body, length: field.size };
          }
          durationTicks = E.readUint(window, field);
        }
      }
      pos = field.next;
    }
    if (inner === null) return "malformed";
    body = inner.body;
    size = inner.size;
  }
  const headNeed = headBytes(size);
  if (!E.covers(window, body, headNeed)) {
    window = yield { at: body, length: headNeed };
  }
  const head = trackOfBlock(window, body, size);
  if (head === "undecodable") return "malformed";
  const { trackNumber, numberBytes } = head;
  const claim = claims.get(trackNumber);
  if (claim === undefined) return null;
  if (head.cut) return "malformed";
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

export function heldBlockHead(window: Window, outer: Element): BlockHead | null {
  let block = outer;
  if (outer.id === ID.cluster.BLOCK_GROUP) {
    const first = E.readElement(window, outer.body);
    if (!E.fits(first, outer.next) || first.id !== ID.blockGroup.BLOCK) return null;
    block = first;
  }
  if (!E.covers(window, block.body, headBytes(block.size))) return null;
  const head = trackOfBlock(window, block.body, block.size);
  if (head === "undecodable" || head.cut) return null;
  const relTicks = relTicksAt(window.bytes, block.body + head.numberBytes - window.at);
  return { trackNumber: head.trackNumber, relTicks };
}

const TIME_AND_FLAGS_BYTES = 3;

const MAX_BLOCK_HEAD_BYTES = E.MAX_VINT_BYTES + TIME_AND_FLAGS_BYTES;

const BLOCK_GROUP_PROBE_BYTES = 256;

const LACING_MASK = 0x06;

// On the browser bundle's path, so `Buffer.readInt16BE` is not available.
const relTicksAt = (bytes: Uint8Array, start: number): number =>
  ((((bytes[start] as number) << 8) | (bytes[start + 1] as number)) << 16) >> 16;

const headBytes = (size: number): number => Math.min(MAX_BLOCK_HEAD_BYTES, size);

/**
 * The TrackNumber of a block whose headBytes(size) the window covers, and its width.
 *
 * "undecodable" where the TrackNumber does not decode inside the block, `cut` where the block cannot hold its time and flags.
 */
function trackOfBlock(window: Window, body: number, size: number): BlockTrack | "undecodable" {
  const trackNumber = E.readVint(window, body);
  if (typeof trackNumber === "string" || trackNumber.length > size) return "undecodable";
  const numberBytes = trackNumber.length;
  const cut = numberBytes + TIME_AND_FLAGS_BYTES > size;
  return { trackNumber: trackNumber.value, numberBytes, cut };
}
