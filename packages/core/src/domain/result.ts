/**
 * Result<T, E> — a discriminated union for explicit error handling.
 *
 * Tool errors must be DATA sent to the model, not exceptions propagating up the
 * call stack. This type makes the failure mode visible in every function signature.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

/** Construct a successful result. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Construct a failed result. */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Transform the value inside an Ok, leaving Err untouched. */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  if (result.ok) {
    return ok(fn(result.value));
  }
  return result;
}

/** Transform the error inside an Err, leaving Ok untouched. */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  if (!result.ok) {
    return err(fn(result.error));
  }
  return result;
}

/**
 * Chain a Result-returning function over an Ok value.
 * Short-circuits on the first Err.
 */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  if (result.ok) {
    return fn(result.value);
  }
  return result;
}

/** Extract the value from an Ok, or return the fallback for an Err. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/**
 * Unwrap the value, throwing if result is an Err.
 * Use only in tests or when an Err is a programming error.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`unwrap called on Err: ${String(result.error)}`);
  }
  return result.value;
}

/**
 * Narrow a Result to Ok. Useful after an explicit ok-check when TypeScript
 * narrowing alone is insufficient.
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}
