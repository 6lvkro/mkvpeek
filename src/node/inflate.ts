import { inflateSync } from "node:zlib";
import type { Inflate } from "../io/source.js";

export const inflateByZlib: Inflate = async (deflated, most) => {
  const zlibOptions = { info: true, maxOutputLength: most };
  const { buffer, engine } = inflateSync(deflated, zlibOptions) as unknown as InflateInfo;
  if (engine.bytesWritten < deflated.length) throw new Error();
  return new Uint8Array(buffer);
};

/** What `inflateSync` answers when asked for `info`, which its type does not say. */
interface InflateInfo {
  buffer: Uint8Array;
  engine: { bytesWritten: number };
}
