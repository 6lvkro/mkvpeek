import { isHttpUrl, urlSource, whyCredentialed } from "../io/http.js";
import { memorySource } from "../io/memory.js";
import type { Source } from "../io/source.js";
import { type RefusalCode, RefusalError } from "../vocabulary.js";

/** A path (Node) or URL string, bytes in hand, or a {@linkcode Source} opened by the caller. */
export type Target = Source | ArrayBufferView | ArrayBuffer | string;

export type Opener = (target: string) => Promise<Source | RefusalCode>;

export interface TargetLease {
  source: Source;
  release?(): Promise<void>;
}

/** Opens a string target that can only be a URL. */
export const viaUrl: Opener = async (target) =>
  isHttpUrl(target) ? urlSource(target) : "invalid-target";

export async function leaseOf(target: Target, open: Opener): Promise<TargetLease> {
  if (typeof target !== "string") return { source: heldSource(target) };
  const parsed = URL.parse(target);
  const secret = parsed === null ? null : whyCredentialed(parsed);
  if (secret !== null) throw new RefusalError("invalid-target");
  const source = await open(target);
  if (typeof source === "string") throw new RefusalError(source);
  const release = async () => {
    await source.close?.().catch(() => {});
  };
  return { source: source, release };
}

function heldSource(target: Exclude<Target, string>): Source {
  if (target instanceof ArrayBuffer || ArrayBuffer.isView(target)) {
    try {
      return memorySource(target);
    } catch {
      throw new RefusalError("invalid-target");
    }
  }
  const readsAndSizes =
    target !== null &&
    target !== undefined &&
    typeof target.read === "function" &&
    typeof target.size === "function";
  if (readsAndSizes) return target;
  throw new RefusalError("invalid-target");
}
