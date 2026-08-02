import { TimeoutError } from "./errors.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Races a promise-producing function against a timer so hung network/model calls can't stall a run forever.
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new TimeoutError(`${label} timed out after ${timeoutMs}ms`, { operation: label })),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle!);
  }
}

export interface RetryOptions {
  label: string;
  retries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  onRetry?: (attempt: number, error: unknown) => void;
}

// Retries a transient-failure-prone call with exponential backoff, optionally bounding each attempt with a timeout.
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { retries = 2, baseDelayMs = 500, timeoutMs, label, onRetry } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return timeoutMs ? await withTimeout(fn, timeoutMs, label) : await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      onRetry?.(attempt + 1, error);
      await delay(baseDelayMs * 2 ** attempt);
    }
  }

  throw lastError;
}
