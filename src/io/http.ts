import type { AsyncDisposal } from "../disposal.js";
import { bytesRange, type Hop, type HopSender, type OwnedTransport, rangeSource } from "./range.js";
import type { Source } from "./source.js";

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
   * A read that goes quiet where a redirect led is tried once more from the start, so its refusal can take twice as long.
   *
   * @defaultValue no limit (a socket that has gone quiet waits until the call's `signal` cuts it)
   */
  stallMs?: number | null;
}

export const whyCredentialed = (parsed: URL): string | null =>
  parsed.username !== "" || parsed.password !== ""
    ? "carries credentials in its URL, and this reader takes them as headers"
    : null;

export const namesAuthority = (target: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(target);

export const callerHeaders = (options: UrlOptions): Record<string, string> =>
  withoutHeaders(options.headers ?? {}, TRANSPORT_OWNED_HEADERS);

/**
 * An HTTP source over `fetch`.
 *
 * A server that answers a Range request with anything but 206 fails the read as `source-failed`.
 */
export async function urlSource(
  url: string,
  options: UrlOptions = {},
): Promise<Source & AsyncDisposal> {
  const transport = fetchTransport(url, options);
  return rangeSource(url, transport, options.stallMs);
}

export function isHttpUrl(target: string): boolean {
  const parsed = URL.parse(target);
  return parsed !== null && speaksHttp(parsed);
}

export function admittedUrl(url: string): URL {
  const parsed = URL.parse(url);
  if (parsed === null) throw new Error(`${url} is not a URL`);
  const why = whyInadmissible(parsed);
  if (why !== null) throw new Error(`${url} ${why}`);
  return parsed;
}

/** For the start hop, fetch is handed the string `url` as given. */
export function fetchHops(url: string, start: Hop, fetchImpl: typeof globalThis.fetch): HopSender {
  return async (hop, from, to, signal) => {
    const headers = new Headers(hop.headers);
    const range = bytesRange(from, to);
    headers.set("Range", range);
    const init = { ...(signal === undefined ? {} : { signal }), headers };
    const target = hop === start ? url : hop.url.href;
    const response = await fetchImpl(target, init);
    const reader = response.body?.getReader();
    const cancel = async () => {
      await reader?.cancel().catch(() => {});
    };
    const reply = {
      status: response.status,
      header: (name: string) => response.headers.get(name),
      body: chunksOf(reader),
      cancel,
    };
    const landed = response.redirected ? URL.parse(response.url) : null;
    return { reply, hop: landed === null ? null : fetchLanding(hop, landed) };
  };
}

const CROSS_ORIGIN_STRIPPED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

const TRANSPORT_OWNED_HEADERS: ReadonlySet<string> = new Set(["host", "range", "accept-encoding"]);

function fetchTransport(url: string, options: UrlOptions): OwnedTransport {
  const { fetch: fetchImpl = globalThis.fetch } = options;
  const start = { url: admittedUrl(url), headers: callerHeaders(options) };
  const send = fetchHops(url, start, fetchImpl);
  const followEachRead: HopSender = async (hop, from, to, signal) => {
    const { reply } = await send(hop, from, to, signal);
    return { reply, hop: null };
  };
  // Skipping hops would hand a caller's fetch a URL other than the string given.
  const chosen = options.fetch === undefined ? send : followEachRead;
  const dispose = () => {};
  return { start, send: chosen, dispose };
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

async function* chunksOf(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
): AsyncIterable<Uint8Array> {
  if (reader === undefined) return;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

function whyInadmissible(parsed: URL): string | null {
  const why = whyCredentialed(parsed);
  if (why !== null) return why;
  if (!speaksHttp(parsed)) return `names ${parsed.protocol}, and this reader speaks http(s)`;
  return null;
}

function speaksHttp(parsed: URL): boolean {
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}
