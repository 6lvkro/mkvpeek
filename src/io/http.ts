import { type AsyncDisposal, disposable } from "../disposal.js";
import { abortReason, givenSignal, linkedSignal } from "./abort.js";
import { available, HEAD_BYTES, lend, type Source } from "./source.js";

export interface UrlOptions {
  /** Sent with every request, but for Host, Range and Accept-Encoding, which the transport owns. */
  headers?: Readonly<Record<string, string>>;
  /**
   * The client every request goes through, for a host that needs HTTP/2, a proxy or a pinned certificate.
   *
   * It is handed the URL as the string given.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * How long the source may deliver nothing before the read is refused.
   *
   * A read that goes quiet where a redirect led is tried once more from the start, so either wait can double.
   *
   * @defaultValue no limit (a read waits until the call's `signal` cuts it, and Node's fetch gives up after 300 seconds of nothing)
   */
  stallMs?: number | null;
}

export const whyCredentialed = (parsed: URL): string | null =>
  parsed.username !== "" || parsed.password !== ""
    ? "carries credentials in its URL, and this reader takes them as headers"
    : null;

export const namesAuthority = (target: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(target);

/**
 * An HTTP source over `fetch`.
 *
 * A server that answers a Range request with anything but 206 fails the read as `source-failed`;
 * an answer that the file is empty is `not-matroska`.
 */
export async function urlSource(
  url: string,
  options: UrlOptions = {},
): Promise<Source & AsyncDisposal> {
  const admitted = admittedUrl(url);
  const named = withoutSecrets(admitted);
  const send = options.fetch ?? globalThis.fetch;
  const headers = withoutHeaders(options.headers ?? {}, TRANSPORT_OWNED_HEADERS);
  const start: Hop = { url: admitted, headers };
  const { stallMs } = options;
  const effectiveStallMs =
    stallMs !== null && stallMs !== undefined && Number.isFinite(stallMs) && stallMs > 0
      ? stallMs
      : null;
  // Skipping hops would hand a caller's fetch a URL other than the string given,
  // so then where a redirect led is not remembered.
  let landing: Hop | null = null;
  let head: { total: number; bytes: Uint8Array } | null = null;

  const acceptedTotal = (response: Response, from: number): number => {
    if (response.status !== 206) {
      // On an empty file, nginx, Apache and lighttpd answer 200 and a length of 0, and the standard says 416 and `*/0`.
      if (response.status === 200 && response.headers.get("content-length") === "0") return 0;
      const unsatisfied = response.headers.get("content-range") ?? "";
      if (response.status === 416 && /^bytes\s+\*\/0\s*$/.test(unsatisfied)) return 0;
      throw new Error(
        `${named} answered HTTP ${String(response.status)} to a Range request; this reader needs a server that serves ranges`,
      );
    }
    const encoding = response.headers.get("content-encoding");
    if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
      const refused = new Error(
        `${named} answered a range in another encoding, and this reader asked for identity`,
      );
      throw Object.assign(refused, { encoding });
    }
    const stated = response.headers.get("content-range") ?? "";
    const contentRange = /^bytes\s+(\d+)-\d+\/(\d+)\s*$/.exec(stated);
    if (contentRange === null) {
      throw new Error(`${named} did not state a total length in Content-Range`);
    }
    const answered = Number(contentRange[1]);
    if (answered !== from) {
      throw new Error(
        `${named} answered a range from ${String(answered)} for one asked from ${String(from)}; this reader needs the bytes it asked for`,
      );
    }
    return Number(contentRange[2]);
  };

  const fetchRange = async (
    hop: Hop,
    from: number,
    to: number,
    into: Uint8Array,
    at: number,
    caller: AbortSignal | undefined,
  ) => {
    const dog = watchdog(named, effectiveStallMs, caller);
    try {
      const sent = new Headers(hop.headers);
      const range = `bytes=${String(from)}-${String(to)}`;
      sent.set("Range", range);
      const init = { ...(dog.signal === undefined ? {} : { signal: dog.signal }), headers: sent };
      const target = hop === start ? url : hop.url.href;
      const response = await send(target, init);
      const reader = response.body?.getReader();
      try {
        const total = acceptedTotal(response, from);
        if (total === 0) return { landed: 0, total };
        const landed = await bodyInto(named, reader, into, at, dog);
        const reached = response.redirected ? URL.parse(response.url) : null;
        if (hop === start && options.fetch === undefined && reached !== null) {
          landing = fetchLanding(start, reached);
        }
        return { landed, total };
      } finally {
        await reader?.cancel().catch(() => {});
        if (nextTurn !== undefined) await new Promise((resume) => nextTurn(resume));
      }
    } finally {
      dog.off();
    }
  };

  /**
   * Where the remembered hop fails for any reason but the caller's signal,
   * it is forgotten and the hops are followed once more from the start.
   */
  const exchange = async (
    from: number,
    to: number,
    into: Uint8Array,
    at: number,
    caller: AbortSignal | undefined,
  ) => {
    const tried = landing;
    if (tried === null) return fetchRange(start, from, to, into, at, caller);
    try {
      return await fetchRange(tried, from, to, into, at, caller);
    } catch (error) {
      if (abortReason(caller) !== null) throw error;
      if (landing === tried) {
        landing = null;
      }
      return fetchRange(start, from, to, into, at, caller);
    }
  };

  const headFor = async (caller: AbortSignal | undefined) => {
    if (head !== null) return head;
    const into = new Uint8Array(HEAD_BYTES);
    const { landed, total } = await exchange(0, HEAD_BYTES - 1, into, 0, caller);
    const kept = Math.min(landed, total);
    const bytes = into.subarray(0, kept);
    head = { total, bytes };
    return head;
  };

  const overRanges = async (
    at: number,
    bounded: number,
    into: Uint8Array | null,
    caller: AbortSignal | undefined,
  ) => {
    const out = into ?? new Uint8Array(bounded);
    let written = 0;
    for (let rounds = 1; written < bounded; rounds += 1) {
      if (rounds > MAX_RESPONSES_PER_READ) {
        throw new Error(
          `${named} dribbled ${String(written)} bytes over ${String(MAX_RESPONSES_PER_READ)} responses for one read; this reader does not pay a request per byte`,
        );
      }
      const from = at + written;
      const { landed } = await exchange(from, at + bounded - 1, out, written, caller);
      if (landed === 0) {
        throw new Error(`${named} answered a range from ${String(from)} with no bytes in it`);
      }
      written += landed;
    }
    return out.subarray(0, written);
  };

  const size = async (given?: AbortSignal) => (await headFor(givenSignal(given))).total;
  const read = async (at: number, length: number, into?: Uint8Array, given?: AbortSignal) => {
    const caller = givenSignal(given);
    const { total, bytes } = await headFor(caller);
    const bounded = available(at, length, total);
    const lent = lend(into, bounded);
    if (at + bounded <= bytes.length) {
      if (lent === null) return new Uint8Array(bytes.subarray(at, at + bounded));
      lent.set(bytes.subarray(at, at + bounded));
      return lent;
    }
    if (at < bytes.length) {
      const fromHead = bytes.length - at;
      const out = lent ?? new Uint8Array(bounded);
      out.set(bytes.subarray(at, bytes.length));
      const room = out.subarray(fromHead);
      const tail = await overRanges(bytes.length, bounded - fromHead, room, caller);
      return out.subarray(0, fromHead + tail.length);
    }
    return overRanges(at, bounded, lent, caller);
  };

  const release = () => Promise.resolve();
  const source: Source = { size, read, close: release, trip: "remote" };
  return disposable(source, release);
}

export function isHttpUrl(target: string): boolean {
  const parsed = URL.parse(target);
  return parsed !== null && speaksHttp(parsed);
}

interface Hop {
  url: URL;
  headers: Readonly<Record<string, string>>;
}

interface Watchdog {
  signal: AbortSignal | undefined;
  alive: () => void;
  off: () => void;
}

const MAX_RESPONSES_PER_READ = 64;

const IDLE_CHUNK_LIMIT = 1000;

const CROSS_ORIGIN_STRIPPED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

const TRANSPORT_OWNED_HEADERS: ReadonlySet<string> = new Set(["host", "range", "accept-encoding"]);

const { setImmediate: nextTurn } = globalThis as {
  setImmediate?: (callback: (value: unknown) => void) => unknown;
};

const withoutSecrets = (url: URL): string => `${url.protocol}//${url.host}`;

function admittedUrl(url: string): URL {
  const parsed = URL.parse(url);
  if (parsed === null) throw new Error("the target is not a URL");
  const credentialed = whyCredentialed(parsed);
  if (credentialed !== null) throw new Error(`${withoutSecrets(parsed)} ${credentialed}`);
  if (!speaksHttp(parsed)) {
    throw new Error(`the target names ${parsed.protocol}, and this reader speaks http(s)`);
  }
  return parsed;
}

/**
 * The hop to send straight to where fetch landed, without the credentials if the origin changed, as fetch does.
 *
 * fetch shows no hop between, so a credentialed request that lands back on the start's origin has no hop to make again.
 */
function fetchLanding(from: Hop, landed: URL): Hop | null {
  if (landed.origin !== from.url.origin) {
    const headers = withoutHeaders(from.headers, CROSS_ORIGIN_STRIPPED_HEADERS);
    return { url: landed, headers };
  }
  const names = Object.keys(from.headers).map((name) => name.toLowerCase());
  const credentialed = names.some((name) => CROSS_ORIGIN_STRIPPED_HEADERS.has(name));
  return credentialed ? null : { url: landed, headers: from.headers };
}

function withoutHeaders(
  headers: Readonly<Record<string, string>>,
  names: ReadonlySet<string>,
): Record<string, string> {
  const kept = Object.entries(headers).filter(([name]) => !names.has(name.toLowerCase()));
  return Object.fromEntries(kept);
}

async function bodyInto(
  named: string,
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  into: Uint8Array,
  at: number,
  dog: Watchdog,
): Promise<number> {
  let written = 0;
  let idle = 0;
  if (reader === undefined) return written;
  for (;;) {
    const next = await reader.read().catch((error: unknown) => {
      const cut = new Error(`${named} stopped sending mid-body (${String(error)})`);
      throw abortReason(dog.signal) ?? cut;
    });
    if (next.done) return written;
    const chunk = next.value;
    if (chunk.length === 0) {
      idle += 1;
      if (idle > IDLE_CHUNK_LIMIT) {
        throw new Error(`${named} sent ${String(idle)} empty chunks in a row and no bytes`);
      }
      continue;
    }
    idle = 0;
    dog.alive();
    const room = into.length - at - written;
    if (room <= 0) return written;
    const kept = Math.min(chunk.length, room);
    const taken = chunk.subarray(0, kept);
    into.set(taken, at + written);
    written += kept;
  }
}

function watchdog(url: string, stallMs: number | null, caller: AbortSignal | undefined): Watchdog {
  if (stallMs === null && caller === undefined) {
    return { signal: undefined, alive: () => {}, off: () => {} };
  }
  const link = linkedSignal(caller);
  if (stallMs === null) return { signal: link.signal, alive: () => {}, off: link.unlink };
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

function speaksHttp(parsed: URL): boolean {
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}
