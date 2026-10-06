import * as E from "./ebml.js";
import { abortReason } from "./io/source.js";
import { type RefusalCode, RefusalError } from "./vocabulary.js";

/** The refusal a throw stands for, which is `cancelled` for any throw once the signal has fired. */
export function refusalOf(
  error: unknown,
  signal: AbortSignal | undefined,
  grammarCode: Extract<RefusalCode, "malformed" | "unreadable"> = "malformed",
): RefusalCode {
  if (abortReason(signal) !== null) return "cancelled";
  if (error instanceof RefusalError) return error.code;
  return E.isGrammarError(error) ? grammarCode : "source-failed";
}
