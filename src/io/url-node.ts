/** URL policy over a node:http transport. */

import http from "node:http";
import https from "node:https";

import {
  bytesRange,
  type OwnedTransport,
  type RangeReply,
  type RangeTransport,
  rangeSource,
} from "./range.js";
import type { Source } from "./source.js";
import { abortReason, onAbort } from "./source.js";
import {
  httpTarget,
  TRANSPORT_OWNED_HEADERS,
  type UrlOptions,
  urlSource as viaFetch,
  whyInadmissible,
  withoutHeaders,
} from "./url.js";

/**
 * An HTTP source over `node:http`, or over `fetch` when one is passed.
 *
 * A server answering a Range request with anything but 206 is not read;
 * the read throws, which the envelope reports as `source-failed`.
 */
export async function urlSource(url: string, options: UrlOptions = {}): Promise<Source> {
  if (options.fetch !== undefined) return viaFetch(url, options);
  const transport = nodeTransport(url, options);
  return rangeSource(url, transport, options);
}

const MAX_SOCKETS = 64;

const MAX_REDIRECTS = 20;

const CROSS_ORIGIN_STRIPPED = new Set(["authorization", "cookie", "proxy-authorization"]);

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function nodeTransport(url: string, options: UrlOptions): OwnedTransport {
  const startUrl = httpTarget(url);
  const agent = {
    "http:": new http.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS }),
    "https:": new https.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS }),
  };
  const headers = withoutHeaders(options.headers ?? {}, TRANSPORT_OWNED_HEADERS);
  const sendRange = (
    parsed: URL,
    carrying: Readonly<Record<string, string>>,
    from: number,
    to: number,
    signal: AbortSignal | undefined,
  ) =>
    new Promise<RangeReply>((resolve, reject) => {
      const secure = parsed.protocol === "https:";
      const lib = secure ? https : http;
      const host = parsed.hostname;
      const requestOptions = {
        hostname: host.startsWith("[") ? host.slice(1, -1) : host,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        agent: agent[secure ? "https:" : "http:"],
        headers: {
          ...carrying,
          "accept-encoding": "identity",
          range: bytesRange(from, to),
        },
      };
      const settle = (response: http.IncomingMessage) => {
        resolve(replyOver(response));
      };
      const request = lib.request(requestOptions, settle);
      const stop = () => {
        request.destroy(abortReason(signal) ?? undefined);
      };
      const unhook = onAbort(signal, stop);
      request.on("close", unhook);
      request.on("error", (error) => {
        unhook();
        reject(error);
      });
      request.end();
    });

  const transport: RangeTransport = async (from, to, signal) => {
    let current = startUrl;
    let carrying = headers;
    for (let left = MAX_REDIRECTS; ; left -= 1) {
      const reply = await sendRange(current, carrying, from, to, signal);
      const location = reply.header("location");
      if (!REDIRECT_STATUS.has(reply.status) || location === null) return reply;
      await reply.cancel();
      if (left === 0) {
        throw new Error(`${url} redirected more than ${String(MAX_REDIRECTS)} times`);
      }
      const next = URL.parse(location, current.href);
      if (next === null) {
        throw new Error(`${url} redirected to ${location}, which is not a URL`);
      }
      const why = whyInadmissible(next);
      if (why !== null) throw new Error(`${url} redirected to one that ${why}`);
      if (next.origin !== current.origin) {
        carrying = withoutHeaders(carrying, CROSS_ORIGIN_STRIPPED);
      }
      current = next;
    }
  };
  const dispose = () => {
    for (const key of ["http:", "https:"] as const) {
      try {
        agent[key].destroy();
      } catch {}
    }
  };
  const owned = { dispose };
  return Object.assign(transport, owned);
}

function replyOver(response: http.IncomingMessage): RangeReply {
  const header = (name: string) => {
    const value = response.headers[name.toLowerCase()];
    return typeof value === "string" ? value : null;
  };
  const cancel = () => {
    response.destroy();
    return Promise.resolve();
  };
  return { status: response.statusCode ?? 0, header, body: response, cancel };
}
