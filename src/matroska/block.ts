import type { Element, Window } from "../ebml.js";
import * as E from "../ebml.js";
import { headerNeed } from "./chain.js";
import type { Undo } from "./encoding.js";

/** The walk buys a block's bytes; the index finds them in held windows, or throws a GrammarError. */
export type BytesSupply = (at: number, need: number) => Promise<Window>;

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

interface BlockHead {
  trackNumber: number;
  relTicks: number;
  laced: boolean;
  payloadAt: number;
  payloadSize: number;
}

/** The rule each block refusal names. */
export const BLOCK_REFUSAL = {
  notThisTrack: "not-this-track",
  notACluster: "not-a-cluster",
  openCluster: "open-cluster",
  noClusterTime: "no-cluster-time",
  runsPastCluster: "runs-past-cluster",
  notAnElement: "not-an-element",
  pastTheCluster: "past-the-cluster",
  notABlock: "not-a-block",
  notFetched: "not-fetched",
  groupChildren: "group-children",
  groupEmpty: "group-empty",
  strayBlock: "stray-block",
  stranger: "stranger",
  blockHead: "block-head",
  laced: "laced",
  shortHead: "short-head",
  undecodable: "undecodable",
} as const;

export type BlockClause = (typeof BLOCK_REFUSAL)[keyof typeof BLOCK_REFUSAL];

export const BLOCK_PROBE_BYTES = 32;

/**
 * One block element as a frame, or null for a track `claims` does not hold.
 *
 * A block that breaks a rule answers that rule's clause.
 */
export async function frameIn(
  outer: Element,
  clusterTicks: number,
  held: Window,
  claims: ReadonlyMap<number, FrameClaim>,
  supply: BytesSupply,
): Promise<BlockFrame | null | BlockClause> {
  let window = held;
  let body = outer.body;
  let size = outer.size;
  let durationTicks: number | null = null;
  if (outer.id === E.ID.cluster.BLOCK_GROUP) {
    const probeBytes = Math.min(outer.size, BLOCK_GROUP_PROBE_BYTES);
    if (!E.covers(window, outer.body, probeBytes)) {
      window = await supply(outer.body, probeBytes);
    }
    let inner: Element | null = null;
    let pos = outer.body;
    while (pos < outer.next) {
      const need = headerNeed(pos, outer.next);
      if (!E.covers(window, pos, need)) {
        window = await supply(pos, need);
      }
      const field = E.readElement(window, pos);
      if (!E.fits(field, outer.next)) return BLOCK_REFUSAL.groupChildren;
      if (field.id === E.ID.blockGroup.BLOCK) {
        inner = field;
      } else if (field.id === E.ID.blockGroup.BLOCK_DURATION) {
        const buys = E.uintFits(field.size) && !E.covers(window, field.body, field.size);
        const covering = buys ? await supply(field.body, field.size) : window;
        durationTicks = E.readUint(covering, field);
      }
      pos = field.next;
    }
    if (inner === null) return BLOCK_REFUSAL.groupEmpty;
    body = inner.body;
    size = inner.size;
  }
  const need = Math.min(MAX_BLOCK_HEAD_BYTES, size);
  if (!E.covers(window, body, need)) {
    window = await supply(body, need);
  }
  const blockHead = readBlockHead(window, body, size);
  if (typeof blockHead === "string") return blockHead;
  const { trackNumber } = blockHead;
  const claim = claims.get(trackNumber);
  if (claim === undefined) return null;
  const fault = blockFault(blockHead);
  if (fault !== null) return fault;
  const covering = E.covers(window, blockHead.payloadAt, blockHead.payloadSize)
    ? window
    : await supply(blockHead.payloadAt, blockHead.payloadSize);
  const stored = E.readBytes(covering, blockHead.payloadAt, blockHead.payloadSize);
  let payload: Uint8Array;
  try {
    payload = claim.undo === null ? stored.slice() : await claim.undo(stored);
  } catch {
    return BLOCK_REFUSAL.undecodable;
  }
  const startTicks = clusterTicks + blockHead.relTicks;
  return { trackNumber, startTicks, durationTicks, payload };
}

export function heldBlockHead(window: Window, outer: Element): BlockHead | null {
  let block = outer;
  if (outer.id === E.ID.cluster.BLOCK_GROUP) {
    const first = E.readElement(window, outer.body);
    if (!E.fits(first, outer.next) || first.id !== E.ID.blockGroup.BLOCK) return null;
    block = first;
  }
  const blockHead = readBlockHead(window, block.body, block.size);
  return typeof blockHead === "string" ? null : blockHead;
}

const TIME_AND_FLAGS_BYTES = 3;

const MAX_BLOCK_HEAD_BYTES = E.MAX_VINT_BYTES + TIME_AND_FLAGS_BYTES;

const BLOCK_GROUP_PROBE_BYTES = 256;

const LACING_MASK = 0x06;

function readBlockHead(window: Window, body: number, size: number): BlockHead | BlockClause {
  const trackNumber = E.readVint(window, body);
  if (typeof trackNumber === "string") return BLOCK_REFUSAL.blockHead;
  const bytesAt = body + trackNumber.length;
  if (!E.covers(window, bytesAt, TIME_AND_FLAGS_BYTES)) return BLOCK_REFUSAL.blockHead;
  const bytes = E.readBytes(window, bytesAt, TIME_AND_FLAGS_BYTES);
  // On the browser bundle's path, so `Buffer.readInt16BE` is not available.
  const relTicks = ((((bytes[0] as number) << 8) | (bytes[1] as number)) << 16) >> 16;
  return {
    trackNumber: trackNumber.value,
    relTicks,
    laced: ((bytes[2] as number) & LACING_MASK) !== 0,
    payloadAt: bytesAt + TIME_AND_FLAGS_BYTES,
    payloadSize: size - (trackNumber.length + TIME_AND_FLAGS_BYTES),
  };
}

function blockFault(blockHead: BlockHead): BlockClause | null {
  if (blockHead.laced) return BLOCK_REFUSAL.laced;
  if (blockHead.payloadSize < 0) return BLOCK_REFUSAL.shortHead;
  return null;
}
