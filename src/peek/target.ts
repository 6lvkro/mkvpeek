import { memorySource } from "../io/memory.js";
import { abortReason, type Source } from "../io/source.js";
import { urlSource, whyCredentialed, whyInadmissible } from "../io/url.js";
import type { Track } from "../tracks/core.js";
import type { RefusalCode } from "../vocabulary.js";
import { absent, type PeekOptions, type PeekOutcome, refused, wantsOf } from "./contract.js";

/** A path (Node) or URL string, bytes in hand, or a {@linkcode Source} opened by the caller. */
export type Target = Source | ArrayBufferView | ArrayBuffer | string;

export type Opener = (
  target: string,
  signal: AbortSignal | undefined,
) => Promise<Source | RefusalCode>;

type Work<T extends Track, O extends PeekOptions> = (
  source: Source,
  options: O,
) => Promise<PeekOutcome<T>>;

export const urlRefusal = (parsed: URL): RefusalCode | null =>
  whyInadmissible(parsed) === null ? null : "invalid-target";

export async function overTarget<T extends Track, O extends PeekOptions>(
  target: Target,
  options: O,
  work: Work<T, O>,
  open: Opener = viaUrl,
): Promise<PeekOutcome<T>> {
  const wants = wantsOf(options);
  const absentAnswer = absent(wants);
  if (typeof target !== "string") {
    if (target instanceof ArrayBuffer || ArrayBuffer.isView(target)) {
      let fromBytes: Source;
      try {
        fromBytes = memorySource(target);
      } catch {
        return refused("invalid-target", absentAnswer);
      }
      return work(fromBytes, options);
    }
    const readsAndSizes =
      target !== null &&
      target !== undefined &&
      typeof target.read === "function" &&
      typeof target.size === "function";
    if (readsAndSizes) return work(target, options);
    return refused("invalid-target", absentAnswer);
  }
  const parsed = URL.parse(target);
  const secret = parsed === null ? null : whyCredentialed(parsed);
  if (parsed !== null && secret !== null) {
    return refused("invalid-target", absentAnswer);
  }
  let source: Source | RefusalCode;
  try {
    source = await open(target, options.signal);
  } catch {
    if (abortReason(options.signal) !== null) return refused("cancelled", absentAnswer);
    return refused("source-failed", absentAnswer);
  }
  if (typeof source === "string") return refused(source, absentAnswer);
  try {
    return await work(source, options);
  } finally {
    await source.close?.().catch(() => {});
  }
}

const viaUrl: Opener = async (target, signal) => {
  const parsed = URL.parse(target);
  if (parsed === null) return "invalid-target";
  return urlRefusal(parsed) ?? urlSource(target, { signal });
};
