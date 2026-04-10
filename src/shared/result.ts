// ─── Result<T, E> — discriminated union para manejo de errores tipado ─────────

class OkResult<T> {
  readonly ok = true as const;
  constructor(public readonly value: T) {}
  isOk(): this is OkResult<T>        { return true; }
  isErr(): this is ErrResult<never>  { return false; }
  unwrap(): T                        { return this.value; }
}

class ErrResult<E extends Error> {
  readonly ok = false as const;
  constructor(public readonly error: E) {}
  isOk(): this is OkResult<never>  { return false; }
  isErr(): this is ErrResult<E>    { return true; }
  unwrap(): never                  { throw this.error; }
}

export type Result<T, E extends Error> = OkResult<T> | ErrResult<E>;

export function Ok<T>(value: T): Result<T, never> {
  return new OkResult(value);
}

export function Err<E extends Error>(error: E): Result<never, E> {
  return new ErrResult(error);
}
