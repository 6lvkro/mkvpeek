import type { Inflate } from "./source.js";

export const inflateByStream: Inflate = async (deflated, most) => {
  const inflating = new DecompressionStream("deflate");
  const writer = inflating.writable.getWriter();
  const owned = new Uint8Array(deflated);
  // Fed in pieces, the stream inflates a few of them before the cap refuses, not the whole input.
  // A write is rejected only when the read is rejected too or was already cancelled.
  const feeding = async () => {
    for (let at = 0; at < owned.length; at += FEED_BYTES) {
      await writer.write(owned.subarray(at, at + FEED_BYTES));
    }
    await writer.close();
  };
  feeding().catch(() => {});
  const reader = inflating.readable.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > most) {
      await reader.cancel();
      throw new Error();
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.length;
  }
  return whole;
};

const FEED_BYTES = 8 * 1024;
