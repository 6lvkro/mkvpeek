import type { AsyncDisposal } from "../disposal.js";
import { bytesRange, type RangeTransport, rangeSource } from "./range.js";
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
   * Unset, a socket that has gone quiet waits until the call's `signal` cuts it.
   */
  stallMs?: number | null;
}

export const TRANSPORT_OWNED_HEADERS: ReadonlySet<string> = new Set(["host", "accept-encoding"]);

export const whyCredentialed = (parsed: URL): string | null =>
  parsed.username !== "" || parsed.password !== ""
    ? "carries credentials in its URL, and this reader takes them as headers"
    : null;

export const namesAuthority = (target: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(target);

export function withoutHeaders(
  headers: Readonly<Record<string, string>>,
  names: ReadonlySet<string>,
): Record<string, string> {
  const kept = Object.entries(headers).filter(([name]) => !names.has(name.toLowerCase()));
  return Object.fromEntries(kept);
}

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

export function whyInadmissible(parsed: URL): string | null {
  const why = whyCredentialed(parsed);
  if (why !== null) return why;
  if (!speaksHttp(parsed)) return `names ${parsed.protocol}, and this reader speaks http(s)`;
  return null;
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

function fetchTransport(url: string, options: UrlOptions): RangeTransport {
  const { headers = {}, fetch: fetchImpl = globalThis.fetch } = options;
  admittedUrl(url);
  const withRange = (from: number, to: number) => {
    const out = new Headers(withoutHeaders(headers, TRANSPORT_OWNED_HEADERS));
    const range = bytesRange(from, to);
    out.set("Range", range);
    return out;
  };
  return async (from, to, signal) => {
    const init = {
      ...(signal === undefined ? {} : { signal }),
      headers: withRange(from, to),
    };
    const response = await fetchImpl(url, init);
    const reader = response.body?.getReader();
    const cancel = async () => {
      await reader?.cancel().catch(() => {});
    };
    return {
      status: response.status,
      header: (name) => response.headers.get(name),
      body: chunksOf(reader),
      cancel,
    };
  };
}

function speaksHttp(parsed: URL): boolean {
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}
