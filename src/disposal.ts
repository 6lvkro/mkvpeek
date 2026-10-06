/** The member `await using` calls, where the lib in use declares `Symbol.asyncDispose`. */
export type AsyncDisposal = SymbolConstructor extends {
  readonly asyncDispose: infer K extends symbol;
}
  ? Record<K, () => Promise<void>>
  : Record<never, never>;

export function disposable<T extends object>(
  target: T,
  dispose: () => Promise<void>,
): T & AsyncDisposal {
  const key = Symbol.asyncDispose ?? Symbol.for("Symbol.asyncDispose");
  (target as Record<symbol, unknown>)[key] = dispose;
  return target as T & AsyncDisposal;
}
