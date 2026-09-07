import {
  abortReason,
  available,
  HEAD_BYTES,
  lend,
  onAbort,
  type Source,
  stopIfAborted,
} from "./source.js";

export interface RangeReply {
  status: number;
  header(name: string): string | null;
  body: AsyncIterable<Uint8Array>;
  cancel(): Promise<void>;
}

export type RangeTransport = (
  from: number,
  to: number,
  signal: AbortSignal | undefined,
) => Promise<RangeReply>;

export type OwnedTransport = RangeTransport & { dispose?: () => void };

export interface RangeOptions {
  /**
   * How long the source may deliver nothing before the read is refused.
   *
   * Unset, a socket that has gone quiet waits until {@linkcode signal} cuts it.
   */
  stallMs?: number | null;
  signal?: AbortSignal | undefined;
}

export const bytesRange = (from: number, to: number): string =>
  `bytes=${String(from)}-${String(to)}`;

export async function rangeSource(
  url: string,
  transport: OwnedTransport,
  { stallMs, signal }: RangeOptions,
): Promise<Source> {
  const stall =
    stallMs !== null && stallMs !== undefined && Number.isFinite(stallMs) && stallMs > 0
      ? stallMs
      : null;
  const invariants: TransportInvariants = {
    url,
    transport,
    stallMs: stall,
    signal: signal ?? undefined,
  };
  const { dispose } = transport;
  let headRead: HeadRead;
  try {
    stopIfAborted(signal);
    headRead = await readHead(invariants);
  } catch (error) {
    try {
      dispose?.();
    } catch {}
    throw error;
  }
  const { total, head } = headRead;
  const size = () => Promise.resolve(total);
  const read = async (at: number, length: number, into?: Uint8Array) => {
    const bounded = available(at, length, total);
    if (bounded === 0) return new Uint8Array(0);
    const borrowed = lend(into, bounded);
    if (at + bounded <= head.length) {
      if (borrowed === null) return new Uint8Array(head.subarray(at, at + bounded));
      borrowed.set(head.subarray(at, at + bounded));
      return borrowed;
    }
    if (at < head.length) {
      const fromHead = head.length - at;
      const out = borrowed ?? new Uint8Array(bounded);
      out.set(head.subarray(at, head.length));
      const room = out.subarray(fromHead);
      const tail = await readOverRanges(invariants, head.length, bounded - fromHead, room);
      return out.subarray(0, fromHead + tail.length);
    }
    return readOverRanges(invariants, at, bounded, borrowed);
  };

  return {
    size,
    read,
    ...(dispose === undefined ? {} : { close: () => Promise.resolve(dispose()) }),
    trip: "remote",
  };
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
  signal: AbortSignal | undefined;
}

interface HeadRead {
  total: number;
  head: Uint8Array;
}

const IDLE_CHUNK_LIMIT = 1000;

const MAX_RESPONSES_PER_READ = 64;

async function requestRange(
  invariants: TransportInvariants,
  dog: Watchdog,
  from: number,
  to: number,
): Promise<RangeReply & { total: number }> {
  const reply = await invariants.transport(from, to, dog.signal);
  const dropped = async (why: string) => {
    await reply.cancel();
    return new Error(why);
  };
  if (reply.status !== 206) {
    throw await dropped(
      `${invariants.url} answered HTTP ${String(reply.status)} to a Range request; this reader needs a server that serves ranges`,
    );
  }
  const encoding = reply.header("content-encoding");
  const recoded = encoding !== null && encoding.trim().toLowerCase() !== "identity";
  if (recoded) {
    throw await dropped(
      `${invariants.url} answered a range encoded as ${encoding}, and this reader asked for identity`,
    );
  }
  const contentRange = /^bytes\s+(\d+)-\d+\/(\d+)\s*$/.exec(reply.header("content-range") ?? "");
  const total = Number(contentRange?.[2]);
  if (contentRange === null || !Number.isSafeInteger(total)) {
    throw await dropped(
      `${invariants.url} did not state a countable total length in Content-Range`,
    );
  }
  const start = Number(contentRange[1]);
  if (start !== from) {
    throw await dropped(
      `${invariants.url} answered a range from ${String(start)} for one asked from ${String(from)}; this reader needs the bytes it asked for`,
    );
  }
  const body = watched(invariants.url, reply.body, dog);
  return { ...reply, total, body };
}

async function readHead(invariants: TransportInvariants): Promise<HeadRead> {
  const dog = watchdog(invariants.url, invariants.stallMs, invariants.signal);
  try {
    const first = await requestRange(invariants, dog, 0, HEAD_BYTES - 1);
    const into = new Uint8Array(available(0, HEAD_BYTES, first.total));
    const landed = await readBodyInto(first, into, 0);
    return { total: first.total, head: into.subarray(0, landed) };
  } finally {
    dog.off();
  }
}

async function readOverRanges(
  invariants: TransportInvariants,
  at: number,
  bounded: number,
  into: Uint8Array | null = null,
): Promise<Uint8Array> {
  const out = into ?? new Uint8Array(bounded);
  let written = 0;
  let rounds = 0;
  const dog = watchdog(invariants.url, invariants.stallMs, invariants.signal);
  try {
    while (written < bounded) {
      rounds += 1;
      if (rounds > MAX_RESPONSES_PER_READ) {
        throw new Error(
          `${invariants.url} dribbled ${String(written)} bytes over ${String(MAX_RESPONSES_PER_READ)} responses for one read; this reader does not pay a request per byte`,
        );
      }
      const from = at + written;
      const response = await requestRange(invariants, dog, from, at + bounded - 1);
      const landed = await readBodyInto(response, out, written);
      if (landed === 0) {
        throw new Error(
          `${invariants.url} answered a range from ${String(from)} with no bytes in it`,
        );
      }
      written += landed;
    }
    return out.subarray(0, written);
  } finally {
    dog.off();
  }
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
    await reply.cancel().catch(() => {});
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
      await new Promise((resolve) => setTimeout(resolve, 0));
      idle += 1;
      if (idle > IDLE_CHUNK_LIMIT) {
        raisedHere = true;
        throw new Error(`${url} sent ${String(idle)} empty chunks in a row and no bytes`);
      }
      const stop = abortReason(dog.signal);
      if (stop !== null) {
        raisedHere = true;
        throw stop;
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
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => {
    clearTimeout(timer);
    const stall = () => {
      const silent = new Error(`${url} sent nothing for ${String(stallMs)}ms`);
      controller.abort(silent);
    };
    timer = setTimeout(stall, stallMs);
  };
  alive();
  const forward = () => controller.abort(caller?.reason);
  const unhook = onAbort(caller, forward);
  const off = () => {
    clearTimeout(timer);
    unhook();
  };
  return { signal: controller.signal, alive, off };
}
