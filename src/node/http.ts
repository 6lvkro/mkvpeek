import http from "node:http";
import https from "node:https";
import type { AsyncDisposal } from "../disposal.js";
import { abortReason, onAbort } from "../io/abort.js";
import {
  admittedUrl,
  callerHeaders,
  fetchTransport,
  type UrlOptions,
  urlSource as viaFetch,
} from "../io/http.js";
import {
  bytesRange,
  type OwnedTransport,
  type RangeReply,
  type RangeTransport,
  rangeSource,
} from "../io/range.js";
import type { Source } from "../io/source.js";
import { MAX_CONCURRENCY } from "../io/source.js";

/**
 * An HTTP source over `node:http`, whose redirects `fetch` follows, or wholly over `fetch` when one is passed.
 *
 * A server that answers a Range request with anything but 206 fails the read as `source-failed`.
 */
export async function urlSource(
  url: string,
  options: UrlOptions = {},
): Promise<Source & AsyncDisposal> {
  if (options.fetch !== undefined) return viaFetch(url, options);
  const transport = nodeTransport(url, options);
  return rangeSource(url, transport, options.stallMs);
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function nodeTransport(url: string, options: UrlOptions): OwnedTransport {
  const startUrl = admittedUrl(url);
  const agent = {
    "http:": new http.Agent({ keepAlive: true, maxSockets: MAX_CONCURRENCY }),
    "https:": new https.Agent({ keepAlive: true, maxSockets: MAX_CONCURRENCY }),
  };
  const headers = callerHeaders(options);
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

  // fetch follows the redirects, so the rules for each hop's credentials and Location are fetch's alone.
  const followByFetch = fetchTransport(url, options);
  const transport: RangeTransport = async (from, to, signal) => {
    const reply = await sendRange(startUrl, headers, from, to, signal);
    const redirected = REDIRECT_STATUS.has(reply.status) && reply.header("location") !== null;
    if (!redirected) return reply;
    await reply.cancel();
    return followByFetch(from, to, signal);
  };
  const dispose = () => {
    for (const key of ["http:", "https:"] as const) agent[key].destroy();
  };
  return Object.assign(transport, { dispose });
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
