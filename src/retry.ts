import { retry } from "node-retry-kit";
import type {
  BackoffStrategy,
  JitterOption,
  OnFailureFn,
  OnRetryFn,
  OnSuccessFn,
  RetryContext,
  ShouldRetryFn,
} from "node-retry-kit";

// Re-export the node-retry-kit types users need for autocomplete,
// so there is a single source of truth for retry configuration.
export type {
  BackoffStrategy,
  JitterOption,
  OnFailureFn,
  OnRetryFn,
  OnSuccessFn,
  RetryContext,
  ShouldRetryFn,
} from "node-retry-kit";

/**
 * Retry configuration for Redis operations.
 *
 * Extends the `node-retry-kit` options relevant to Redis workloads with
 * two Redis-specific gates (`reads` / `writes`). Randomness / clock
 * overrides (`random`, `sleep`, `now`) and `wrapErrors` are intentionally
 * not exposed: errors are always rethrown unwrapped so existing
 * `instanceof` checks keep working.
 *
 * Disabled by default (`retries: 0`), i.e. each Redis command executes
 * exactly once unless retries are explicitly configured.
 */
export interface RedisRetryOptions {
  /** Number of retries after the first attempt. `0` = disabled (default). */
  retries?: number;
  /** Backoff strategy between attempts. @default "exponential" */
  backoff?: BackoffStrategy;
  /** Base delay in ms. @default 1000 (node-retry-kit default) */
  delay?: number;
  /** Max delay cap in ms. @default 30000 (node-retry-kit default) */
  maxDelay?: number;
  /** Jitter strategy. @default false */
  jitter?: JitterOption;
  /** Per-attempt timeout in ms (> 0). No default. */
  timeout?: number;
  /** AbortSignal cancelling the whole retry operation. */
  signal?: AbortSignal;
  /**
   * Return `false` to stop retrying immediately. Consulted only for errors
   * already classified as transient (see {@link isTransientRedisError}).
   */
  shouldRetry?: ShouldRetryFn;
  /** Called before each wait. Hook failures are swallowed. */
  onRetry?: OnRetryFn;
  /** Called once when an attempt succeeds. Hook failures are swallowed. */
  onSuccess?: OnSuccessFn;
  /** Called once when giving up. Hook failures are swallowed. */
  onFailure?: OnFailureFn;
  /**
   * Whether read commands (`SCAN`, `GET`) may be retried.
   * @default true
   */
  reads?: boolean;
  /**
   * Whether write commands (`SET`, `DEL`) may be retried.
   * @default true
   *
   * All writes performed by this ORM are whole-document overwrites
   * (`SET key <full JSON>`) or key deletions (`DEL`), which are
   * idempotent and safe to retry. Set to `false` to disable write
   * retries if your usage differs.
   */
  writes?: boolean;
}

/** Global ORM configuration. */
export interface RedisORMConfig {
  retry?: RedisRetryOptions;
}

const DEFAULT_CONFIG: RedisORMConfig = {};

let globalConfig: RedisORMConfig = { ...DEFAULT_CONFIG };

/**
 * Configure the ORM globally (currently: retry policy).
 * Existing behavior is unchanged unless `retry.retries > 0` is set.
 */
export function configureRedisORM(config: RedisORMConfig): void {
  globalConfig = {
    ...globalConfig,
    ...config,
    retry: config.retry ? { ...config.retry } : globalConfig.retry,
  };
}

/** Read a copy of the current global configuration. */
export function getRedisORMConfig(): RedisORMConfig {
  return {
    ...globalConfig,
    ...(globalConfig.retry ? { retry: { ...globalConfig.retry } } : {}),
  };
}

/** Reset global configuration to defaults (retry disabled). */
export function resetRedisORMConfig(): void {
  globalConfig = { ...DEFAULT_CONFIG };
}

/**
 * `RedisORM` namespace for global configuration.
 *
 * Provided so `RedisORM.configure({ retry: {...} })` works as documented.
 * There is no other configuration system in this package; this is it.
 */
export const RedisORM = {
  configure: configureRedisORM,
  getConfig: getRedisORMConfig,
  resetConfig: resetRedisORMConfig,
};

/** Commands that only read data (safe to retry). */
const READ_COMMANDS = new Set(["scan", "get"]);

/** Commands that mutate data. */
const WRITE_COMMANDS = new Set(["set", "del"]);

/** True for commands that mutate data (`SET`, `DEL`). */
export function isWriteCommand(command: string): boolean {
  return WRITE_COMMANDS.has(command.toLowerCase());
}

/** True for commands that only read data (`SCAN`, `GET`). */
export function isReadCommand(command: string): boolean {
  return READ_COMMANDS.has(command.toLowerCase());
}

/** Network / OS error codes that indicate a transient failure. */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "EIO",
  "NR_CLOSED",
  "CONNECTION_CLOSED",
  "CLIENT_CLOSED",
]);

/** node-redis error names / message fragments indicating transient faults. */
const TRANSIENT_NAME_PATTERN =
  /(socketclosed|clientclosed|connectionclosed|timeout|timedout|reconnect|offlinequeue|nodeready|loading|tryagain|busy|clusterdown|connection)/i;

const TRANSIENT_MESSAGE_PATTERN =
  /(connection (reset|refused|closed|lost|timed?\s?out)|socket (closed|hang up|timeout)|timed?\s?out|try again|loading dataset|busy|temporar|econn|epipe|enotfound|network|offline|reconnect)/i;

/** Extract a string error code from common client error shapes. */
function getErrorCode(error: unknown): string | undefined {
  if (error == null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code.toUpperCase() : undefined;
}

/**
 * Decide whether a Redis failure is worth retrying.
 *
 * Retryable (transient): connection / network failures, timeouts,
 * "please try again" style server responses (LOADING, TRYAGAIN, BUSY,
 * CLUSTERDOWN) that signal a momentary condition.
 *
 * NOT retryable (permanent): authentication / permission errors
 * (WRONGPASS, NOAUTH, NOPERM), unknown commands, wrong argument counts,
 * WRONGTYPE and other data errors, and `AbortError`s. Retrying those can
 * never succeed and only adds latency.
 */
export function isTransientRedisError(error: unknown): boolean {
  if (error == null) return false;

  // Cancellation is never retried.
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (typeof error === "object") {
    const name = (error as { name?: unknown }).name;
    if (name === "AbortError" || name === "Abort") return false;
    // node-retry-kit per-attempt timeouts surface as TimeoutError and are
    // retryable like any other timeout.
    if (name === "TimeoutError") return true;
  }

  const code = getErrorCode(error);
  if (code) {
    if (TRANSIENT_CODES.has(code)) return true;
    // Explicitly non-transient families; checked before message fallbacks.
    if (
      code === "WRONGPASS" ||
      code === "NOAUTH" ||
      code === "NOPERM" ||
      code.startsWith("ERR_") ||
      code.startsWith("REPLY_")
    ) {
      return false;
    }
  }

  if (typeof error === "object") {
    const err = error as { name?: unknown; message?: unknown };
    if (typeof err.name === "string" && TRANSIENT_NAME_PATTERN.test(err.name)) {
      return true;
    }
    if (
      typeof err.message === "string" &&
      TRANSIENT_MESSAGE_PATTERN.test(err.message)
    ) {
      return true;
    }
  }

  return false;
}

/** Per-operation retry override (second options argument on model methods). */
export interface OperationOptions {
  retry?: RedisRetryOptions;
  signal?: AbortSignal;
}

/** Resolve the effective retry config: global merged with per-op override. */
export function resolveRetryConfig(
  override?: RedisRetryOptions | OperationOptions
): { retry: RedisRetryOptions; signal?: AbortSignal } {
  const global = globalConfig.retry ?? {};
  let opRetry: RedisRetryOptions = {};
  let opSignal: AbortSignal | undefined;

  if (override) {
    if ("retry" in override || "signal" in override) {
      const op = override as OperationOptions;
      opRetry = op.retry ?? {};
      opSignal = op.signal;
    } else {
      opRetry = override as RedisRetryOptions;
    }
  }

  const retry: RedisRetryOptions = { ...global, ...opRetry };
  const signal = opSignal ?? retry.signal ?? global.signal;
  return { retry, signal };
}

/**
 * Centralized Redis command execution with opt-in retries.
 *
 * This is the ONLY place retry logic lives. ORM methods must route every
 * Redis round-trip (`SCAN`, `GET`, `SET`, `DEL`) through here instead of
 * implementing their own retry loops.
 *
 * - Retry is disabled unless the effective `retries` is > 0.
 * - Only transient errors (see {@link isTransientRedisError}) are retried.
 * - `reads: false` / `writes: false` disable retries per command class.
 * - Errors are rethrown unwrapped (`wrapErrors: false`) so callers keep
 *   seeing the original error; ORM call sites wrap it in `RedisError`
 *   with `cause`, as before.
 * - The (optional) AbortSignal only cancels retry waits / the retry loop;
 *   node-redis v4 commands do not accept a signal, so an in-flight command
 *   still runs to completion. Pending retry timers never dangle.
 */
export async function executeRedisCommand<T>(
  command: string,
  fn: () => Promise<T>,
  override?: RedisRetryOptions | OperationOptions
): Promise<T> {
  const { retry: effective, signal } = resolveRetryConfig(override);
  const retries = effective.retries ?? 0;

  if (retries <= 0) {
    return fn();
  }

  const normalized = command.toLowerCase();
  if (isReadCommand(normalized) && effective.reads === false) {
    return fn();
  }
  if (isWriteCommand(normalized) && effective.writes === false) {
    return fn();
  }

  const userShouldRetry = effective.shouldRetry;
  const shouldRetry: ShouldRetryFn = async (error, context) => {
    if (!isTransientRedisError(error)) return false;
    if (userShouldRetry) {
      try {
        return (await userShouldRetry(error, context)) !== false;
      } catch {
        return false;
      }
    }
    return true;
  };

  return retry(fn, {
    retries,
    backoff: effective.backoff,
    delay: effective.delay,
    maxDelay: effective.maxDelay,
    jitter: effective.jitter,
    timeout: effective.timeout,
    signal,
    shouldRetry,
    onRetry: effective.onRetry,
    onSuccess: effective.onSuccess,
    onFailure: effective.onFailure,
    wrapErrors: false,
  });
}
