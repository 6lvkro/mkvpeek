import * as E from "./ebml.js";
import { abortReason } from "./io/source.js";
import { type RefusalCode, RefusalError } from "./vocabulary.js";

export function refusalOf(
  cause: unknown,
  signal: AbortSignal | undefined,
  grammarCode: Extract<RefusalCode, "malformed" | "unreadable"> = "malformed",
): RefusalError {
  if (abortReason(signal) !== null) return new RefusalError("cancelled");
  if (cause instanceof RefusalError) return cause;
  if (E.isGrammarError(cause)) return new RefusalError(grammarCode);
  return new RefusalError("source-failed", { cause });
}
