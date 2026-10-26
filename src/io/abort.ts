export interface Watch {
  onProgress: ReportBytes;
  signal: AbortSignal;
}

/** A signal that fires with the first of the signals it links, or at its own abort, and then listens to none. */
export interface Link {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  unlink: () => void;
}

type ReportBytes = (done: number, total: number) => void;

export const givenSignal = (signal: AbortSignal | null | undefined): AbortSignal | undefined =>
  signal ?? undefined;

export function stopIfAborted(signal: AbortSignal | undefined): void {
  const reason = abortReason(signal);
  if (reason !== null) throw reason;
}

/** A Watch whose report cannot end the read by throwing, and is not made once the signal fires. */
export function watchOver(signal: AbortSignal, report: ReportBytes): Watch {
  const onProgress: ReportBytes = (done, total) => {
    if (signal.aborted) return;
    let returned: unknown;
    try {
      returned = report(done, total);
    } catch {}
    if (returned instanceof Promise) returned.catch(() => {});
  };
  return { onProgress, signal };
}

export function linkedSignal(...signals: ReadonlyArray<AbortSignal | undefined>): Link {
  const linked = new AbortController();
  const unhooks: Array<() => void> = [];
  const unlink = () => {
    for (const unhook of unhooks.splice(0)) unhook();
  };
  const abort = (reason?: unknown) => {
    unlink();
    linked.abort(reason);
  };
  for (const signal of signals) {
    if (signal === undefined) continue;
    const fired = () => abort(signal.reason);
    unhooks.push(onAbort(signal, fired));
  }
  return { signal: linked.signal, abort, unlink };
}

export function untilAborted<T>(answer: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const unhook = onAbort(signal, () => reject(abortReason(signal)));
    answer.then(
      (value) => {
        unhook();
        resolve(value);
      },
      (error: unknown) => {
        unhook();
        reject(error);
      },
    );
  });
}

export function onAbort(signal: AbortSignal | undefined, run: () => void): () => void {
  if (signal === undefined) return () => {};
  if (signal.aborted) {
    run();
    return () => {};
  }
  signal.addEventListener("abort", run, { once: true });
  return () => signal.removeEventListener("abort", run);
}

export function abortReason(signal: AbortSignal | undefined): Error | null {
  if (signal?.aborted !== true) return null;
  const { reason: cause } = signal;
  try {
    return cause instanceof Error ? cause : new Error(String(cause));
  } catch {
    return new Error("aborted", { cause });
  }
}
