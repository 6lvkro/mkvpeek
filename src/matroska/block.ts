import type { Element, Window } from "../ebml.js";
import * as E from "../ebml.js";
import { headerNeed } from "./chain.js";

export interface Frame {
  readOrder: number | null;
  startTicks: number;
  durationTicks: number | null;
  payload: string;
}

/**
 * The hand that supplies bytes.
 *
 * The walk buys them, the index finds them in held windows; failing that, a GrammarError.
 */
export type BytesSupply = (at: number, need: number) => Promise<Window>;

/** For a claimed track, whether it is numbered; otherwise null. */
export type TrackClaim = (track: number) => boolean | null;

interface ClaimedFrame {
  track: number;
  frame: Frame;
}

/** The definitions that name which rule stood at a refusal. */
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
} as const;

export type BlockClause = (typeof BLOCK_REFUSAL)[keyof typeof BLOCK_REFUSAL];

export const BLOCK_HEAD_BYTES = 32;

/**
 * One block element as a frame.
 *
 * An unclaimed track is null, and a rule that stands is its clause.
 */
export async function frameIn(
  outer: Element,
  clusterTicks: number,
  held: Window,
  claim: TrackClaim,
  supply: BytesSupply,
): Promise<ClaimedFrame | null | BlockClause> {
  let window = held;
  let body = outer.body;
  let size = outer.size;
  let durationTicks: number | null = null;
  if (outer.id === E.ID.cluster.BLOCK_GROUP) {
    const probe = Math.min(outer.size, BLOCK_GROUP_PROBE_BYTES);
    if (!E.covers(window, outer.body, probe)) {
      window = await supply(outer.body, probe);
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
  const need = Math.min(BLOCK_FIELD_BYTES, size);
  if (!E.covers(window, body, need)) {
    window = await supply(body, need);
  }
  const head = readBlockHead(window, body, size);
  if (typeof head === "string") return head;
  const numbered = claim(head.track);
  if (numbered === null) return null;
  const fault = blockFault(head);
  if (fault !== null) return fault;
  const covering = E.covers(window, head.payloadAt, head.payloadSize)
    ? window
    : await supply(head.payloadAt, head.payloadSize);
  const payload = E.readBytes(covering, head.payloadAt, head.payloadSize);
  const frameFields = { payload: E.decodeUtf8(payload), clusterTicks, durationTicks, numbered };
  const frame = frameOf(head, frameFields);
  return { track: head.track, frame };
}

interface BlockHead {
  track: number;
  relTicks: number;
  laced: boolean;
  payloadAt: number;
  payloadSize: number;
}

interface FrameFields {
  payload: string;
  clusterTicks: number;
  durationTicks: number | null;
  numbered: boolean;
}

const TIME_AND_FLAGS_BYTES = 3;

const BLOCK_FIELD_BYTES = E.MAX_VINT_BYTES + TIME_AND_FLAGS_BYTES;

const BLOCK_GROUP_PROBE_BYTES = 256;

const LACING_MASK = 0x06;

function readBlockHead(window: Window, body: number, size: number): BlockHead | BlockClause {
  const track = E.readVint(window, body, "size");
  if (typeof track === "string") return BLOCK_REFUSAL.blockHead;
  const bytesAt = body + track.length;
  if (!E.covers(window, bytesAt, TIME_AND_FLAGS_BYTES)) return BLOCK_REFUSAL.blockHead;
  const bytes = E.readBytes(window, bytesAt, TIME_AND_FLAGS_BYTES);
  // On the browser bundle's path, so `Buffer.readInt16BE` is not available.
  const relTicks = ((((bytes[0] as number) << 8) | (bytes[1] as number)) << 16) >> 16;
  return {
    track: track.value,
    relTicks,
    laced: ((bytes[2] as number) & LACING_MASK) !== 0,
    payloadAt: bytesAt + TIME_AND_FLAGS_BYTES,
    payloadSize: size - (track.length + TIME_AND_FLAGS_BYTES),
  };
}

function blockFault(block: BlockHead): BlockClause | null {
  if (block.laced) return BLOCK_REFUSAL.laced;
  if (block.payloadSize < 0) return BLOCK_REFUSAL.shortHead;
  return null;
}

function frameOf(
  head: BlockHead,
  { payload, clusterTicks, durationTicks, numbered }: FrameFields,
): Frame {
  const lead = numbered ? /^(\d+),/.exec(payload) : null;
  return {
    readOrder: lead === null ? null : Number(lead[1]),
    startTicks: clusterTicks + head.relTicks,
    durationTicks,
    payload,
  };
}
