import { onAbort, untilAborted } from "./source.js";

type Gathered<T extends readonly (() => Promise<unknown>)[]> = {
  [K in keyof T]: Awaited<ReturnType<T[K]>>;
};

/** A queue whose halt is shared. */
export class HaltableQueue<T> {
  #items: T[] = [];
  #next = 0;
  #closed = false;
  #halted = false;
  #parked: Array<() => void> = [];
  readonly #onHalt: () => void;

  constructor(onHalt: () => void) {
    this.#onHalt = onHalt;
  }

  get halted(): boolean {
    return this.#halted;
  }

  push(item: T): void {
    this.#items.push(item);
    this.#parked.shift()?.();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  halt(): void {
    this.#halted = true;
    this.#wake();
    this.#onHalt();
  }

  async drain(
    concurrency: number,
    each: (item: T) => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<void> {
    const take = () => this.#take();
    const halt = () => this.halt();
    await runWorkers(take, halt, concurrency, each, signal);
  }

  async #take(): Promise<T | null> {
    while (!this.#halted) {
      if (this.#next < this.#items.length) {
        const item = this.#items[this.#next] as T;
        this.#next += 1;
        return item;
      }
      if (this.#closed) return null;
      await new Promise<void>((resolve) => {
        this.#parked.push(resolve);
      });
    }
    return null;
  }

  #wake(): void {
    for (const wake of this.#parked.splice(0)) wake();
  }
}

export async function inParallel<T, R>(
  items: readonly T[],
  concurrency: number,
  each: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const take = (): Promise<[T, number] | null> => {
    const index = next;
    next += 1;
    return Promise.resolve(index >= items.length ? null : [items[index] as T, index]);
  };
  const halt = () => {};
  const store = async ([item, index]: [T, number]) => {
    out[index] = await each(item);
    return true;
  };
  await runWorkers(take, halt, Math.min(concurrency, items.length), store, signal);
  return out;
}

/** A heterogeneous batch, each slot answering in its own type. */
export async function gathered<T extends readonly (() => Promise<unknown>)[]>(
  tasks: T,
  concurrency: number,
  signal?: AbortSignal,
): Promise<Gathered<T>> {
  const run = (task: () => Promise<unknown>) => task();
  const out = await inParallel(tasks, concurrency, run, signal);
  return out as Gathered<T>;
}

export async function joinOrAbort(
  lanes: ReadonlyArray<Promise<unknown>>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const join = Promise.allSettled(lanes);
  for (const one of await untilAborted(join, signal)) {
    if (one.status === "rejected") throw one.reason as Error;
  }
}

async function runWorkers<T>(
  take: () => Promise<T | null>,
  halt: () => void,
  concurrency: number,
  each: (item: T) => Promise<boolean>,
  signal: AbortSignal | undefined,
): Promise<void> {
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    halt();
  };
  const unhook = onAbort(signal, stop);
  const worker = async (): Promise<void> => {
    while (!stopped) {
      const item = await take();
      if (item === null) return;
      try {
        if (!(await each(item))) {
          stop();
          return;
        }
      } catch (error) {
        stop();
        throw error;
      }
    }
  };
  try {
    const lanes = Array.from({ length: concurrency }, worker);
    await joinOrAbort(lanes, signal);
  } finally {
    unhook();
  }
}
