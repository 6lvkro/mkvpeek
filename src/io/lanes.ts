import { onAbort, untilAborted } from "./abort.js";

type Gathered<T extends readonly Task[]> = {
  [K in keyof T]: Awaited<ReturnType<T[K]>>;
};

type Task = () => Promise<unknown>;

export class HaltableQueue<T> {
  #items: T[] = [];
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

  /** Wakes no lane that waits, so whoever closes a halted queue wakes them with close. */
  halt(): void {
    this.#halted = true;
    this.#onHalt();
  }

  async drain(concurrency: number, each: Each<T>, signal?: AbortSignal): Promise<void> {
    const take = () => this.#take();
    const halt = () => this.halt();
    await runWorkers(take, halt, concurrency, each, signal);
  }

  async #take(): Promise<T | null> {
    while (!this.#halted) {
      if (this.#items.length > 0) return this.#items.shift() as T;
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

/** A heterogeneous batch, each slot answering in its own type. */
export async function gathered<T extends readonly Task[]>(
  tasks: T,
  concurrency: number,
  signal?: AbortSignal,
): Promise<Gathered<T>> {
  const run = (task: Task) => task();
  const out = await inParallel(tasks, concurrency, run, signal);
  return out as Gathered<T>;
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

export async function joinOrAbort(
  lanes: ReadonlyArray<Promise<unknown>>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const join = Promise.allSettled(lanes);
  for (const one of await untilAborted(join, signal)) {
    if (one.status === "rejected") throw one.reason as Error;
  }
}

/** Answers whether to go on; false stops every lane. */
type Each<T> = (item: T) => Promise<boolean>;

async function runWorkers<T>(
  take: () => Promise<T | null>,
  halt: () => void,
  concurrency: number,
  each: Each<T>,
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
