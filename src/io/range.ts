import { type AsyncDisposal, disposable } from "../disposal.js";
import { abortReason, givenSignal, linkedSignal } from "./abort.js";
import { available, HEAD_BYTES, lend, type Source } from "./source.js";

export type OwnedTransport = RangeTransport & { dispose: () => void };

export interface RangeTransport {
  start: Hop;
  send: HopSender;
}

/** Follows redirects, starting at `hop`. */
export type HopSender = (
  hop: Hop,
  from: number,
  to: number,
  signal: AbortSignal | undefined,
) => Promise<Reached>;

export interface Reached {
  reply: RangeReply;
  /** Where a redirect led, for later reads to go straight to, or null where there is none. */
  hop: Hop | null;
}

export interface Hop {
  url: URL;
  headers: Readonly<Record<string, string>>;
}

export interface RangeReply {
  status: number;
  header(name: string): string | null;
  body: AsyncIterable<Uint8Array>;
  cancel(): Promise<void>;
}

export const bytesRange = (from: number, to: number): string =>
  `bytes=${String(from)}-${String(to)}`;

export function rangeSource(
  url: string,
  transport: OwnedTransport,
  stallMs: number | null | undefined,
): Source & AsyncDisposal {
  const effectiveStallMs =
    stallMs !== null && stallMs !== undefined && Number.isFinite(stallMs) && stallMs > 0
      ? stallMs
      : null;
  const invariants: TransportInvariants = {
    url,
    transport,
    stallMs: effectiveStallMs,
    memory: { landing: null },
  };
  let headRead: HeadRead | null = null;
  const headFor = async (signal: AbortSignal | undefined): Promise<HeadRead> => {
    headRead ??= await readHead(invariants, signal);
    return headRead;
  };
  const size = async (given?: AbortSignal) => (await headFor(givenSignal(given))).total;
  const read = async (at: number, length: number, into?: Uint8Array, given?: AbortSignal) => {
    const signal = givenSignal(given);
    const { total, head } = await headFor(signal);
    const bounded = available(at, length, total);
    const lent = lend(into, bounded);
    if (at + bounded <= head.length) {
      if (lent === null) return new Uint8Array(head.subarray(at, at + bounded));
      lent.set(head.subarray(at, at + bounded));
      return lent;
    }
    if (at < head.length) {
      const fromHead = head.length - at;
      const out = lent ?? new Uint8Array(bounded);
      out.set(head.subarray(at, head.length));
      const room = out.subarray(fromHead);
      const tail = await readOverRanges(invariants, head.length, bounded - fromHead, room, signal);
      return out.subarray(0, fromHead + tail.length);
    }
    return readOverRanges(invariants, at, bounded, lent, signal);
  };

  const release = () => Promise.resolve(transport.dispose());
  const source: Source = { size, read, close: release, trip: "remote" };
  return disposable(source, release);
}

interface Watchdog {
  signal: AbortSignal | undefined;
  alive: () => void;
  off: () => void;
}

interface TransportInvariants {
  url: string;
  transport: RangeTransport;
  stallMs: number | null;
  memory: { landing: Hop | null };
}

interface HeadRead {
  total: number;
  head: Uint8Array;
}

interface Exchanged {
  landed: number;
  total: number;
}

const IDLE_CHUNK_LIMIT = 1000;

const MAX_RESPONSES_PER_READ = 64;

async function readHead(
  invariants: TransportInvariants,
  signal: AbortSignal | undefined,
): Promise<HeadRead> {
  const into = new Uint8Array(HEAD_BYTES);
  const { landed, total } = await exchange(invariants, 0, HEAD_BYTES - 1, into, 0, signal);
  const kept = Math.min(landed, total);
  return { total, head: into.subarray(0, kept) };
}

async function readOverRanges(
  invariants: TransportInvariants,
  at: number,
  bounded: number,
  into: Uint8Array | null,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const out = into ?? new Uint8Array(bounded);
  let written = 0;
  let rounds = 0;
  while (written < bounded) {
    rounds += 1;
    if (rounds > MAX_RESPONSES_PER_READ) {
      throw new Error(
        `${invariants.url} dribbled ${String(written)} bytes over ${String(MAX_RESPONSES_PER_READ)} responses for one read; this reader does not pay a request per byte`,
      );
    }
    const from = at + written;
    const { landed } = await exchange(invariants, from, at + bounded - 1, out, written, signal);
    if (landed === 0) {
      throw new Error(
        `${invariants.url} answered a range from ${String(from)} with no bytes in it`,
      );
    }
    written += landed;
  }
  return out.subarray(0, written);
}

/**
 * Sends a read straight to where a redirect led, once a read there has arrived.
 *
 * Where that hop fails for any reason but the caller's signal,
 * it is forgotten and the hops are followed once more from the start.
 */
async function exchange(
  invariants: TransportInvariants,
  from: number,
  to: number,
  into: Uint8Array,
  at: number,
  caller: AbortSignal | undefined,
): Promise<Exchanged> {
  const { transport, memory } = invariants;
  const tried = memory.landing;
  if (tried === null) return fetchRange(invariants, transport.start, from, to, into, at, caller);
  try {
    return await fetchRange(invariants, tried, from, to, into, at, caller);
  } catch (error) {
    if (abortReason(caller) !== null) throw error;
    if (memory.landing === tried) {
      memory.landing = null;
    }
    return fetchRange(invariants, transport.start, from, to, into, at, caller);
  }
}

async function fetchRange(
  invariants: TransportInvariants,
  hop: Hop,
  from: number,
  to: number,
  into: Uint8Array,
  at: number,
  caller: AbortSignal | undefined,
): Promise<Exchanged> {
  const dog = watchdog(invariants.url, invariants.stallMs, caller);
  try {
    const { reply, hop: reached } = await invariants.transport.send(hop, from, to, dog.signal);
    const answer = await accepted(invariants.url, reply, from, dog);
    if (answer.total === 0) {
      await reply.cancel();
      return { landed: 0, total: 0 };
    }
    const landed = await readBodyInto(answer, into, at);
    if (hop === invariants.transport.start && reached !== null) {
      invariants.memory.landing = reached;
    }
    return { landed, total: answer.total };
  } finally {
    dog.off();
  }
}

async function accepted(
  url: string,
  reply: RangeReply,
  from: number,
  dog: Watchdog,
): Promise<RangeReply & { total: number }> {
  const dropped = async (why: string) => {
    await reply.cancel();
    return new Error(why);
  };
  if (reply.status !== 206) {
    throw await dropped(
      `${url} answered HTTP ${String(reply.status)} to a Range request; this reader needs a server that serves ranges`,
    );
  }
  const encoding = reply.header("content-encoding");
  const recoded = encoding !== null && encoding.trim().toLowerCase() !== "identity";
  if (recoded) {
    const refused = await dropped(
      `${url} answered a range in another encoding, and this reader asked for identity`,
    );
    throw Object.assign(refused, { encoding });
  }
  const contentRange = /^bytes\s+(\d+)-\d+\/(\d+)\s*$/.exec(reply.header("content-range") ?? "");
  if (contentRange === null) {
    throw await dropped(`${url} did not state a total length in Content-Range`);
  }
  const start = Number(contentRange[1]);
  const total = Number(contentRange[2]);
  if (start !== from) {
    throw await dropped(
      `${url} answered a range from ${String(start)} for one asked from ${String(from)}; this reader needs the bytes it asked for`,
    );
  }
  const body = watched(url, reply.body, dog);
  return { ...reply, total, body };
}

async function readBodyInto(reply: RangeReply, into: Uint8Array, at: number): Promise<number> {
  let written = 0;
  try {
    for await (const value of reply.body) {
      const room = into.length - at - written;
      if (room <= 0) break;
      const kept = Math.min(value.length, room);
      const taken = value.subarray(0, kept);
      into.set(taken, at + written);
      written += kept;
    }
  } finally {
    await reply.cancel();
  }
  return written;
}

async function* watched(
  url: string,
  body: AsyncIterable<Uint8Array>,
  dog: Watchdog,
): AsyncIterable<Uint8Array> {
  let idle = 0;
  let raisedHere = false;
  try {
    for await (const chunk of body) {
      if (chunk.length > 0) {
        idle = 0;
        dog.alive();
        yield chunk;
        continue;
      }
      idle += 1;
      if (idle > IDLE_CHUNK_LIMIT) {
        raisedHere = true;
        throw new Error(`${url} sent ${String(idle)} empty chunks in a row and no bytes`);
      }
    }
  } catch (error) {
    if (raisedHere) throw error;
    throw (
      abortReason(dog.signal) ?? new Error(`${url} stopped sending mid-body (${String(error)})`)
    );
  }
}

function watchdog(url: string, stallMs: number | null, caller: AbortSignal | undefined): Watchdog {
  if (stallMs === null) return { signal: caller, alive: () => {}, off: () => {} };
  const link = linkedSignal(caller);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => {
    clearTimeout(timer);
    const stall = () => {
      const silent = new Error(`${url} sent nothing for ${String(stallMs)}ms`);
      link.abort(silent);
    };
    timer = setTimeout(stall, stallMs);
  };
  alive();
  const off = () => {
    clearTimeout(timer);
    link.unlink();
  };
  return { signal: link.signal, alive, off };
}
