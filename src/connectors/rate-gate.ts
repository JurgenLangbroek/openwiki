export type RateGateOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
  now?: () => number;
  requestsPerSecond: number;
  sleep?: (durationMs: number) => Promise<void>;
};

export type RateGate = {
  run: <Result>(fn: () => Promise<Result>) => Promise<Result>;
  setRequestsPerSecond: (requestsPerSecond: number) => void;
};

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 30_000;
const readHighResolutionTime = process.hrtime.bigint.bind(process.hrtime);

export function createRateGate({
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  now = defaultNow,
  requestsPerSecond,
  sleep = defaultSleep,
}: RateGateOptions): RateGate {
  let intervalMs = calculateIntervalMs(requestsPerSecond);
  let nextInvocationAt = now();
  let lastScheduledInvocationAt: number | undefined;
  let pacingTail = Promise.resolve();

  const invokeWhenReady = async <Result>(
    fn: () => Promise<Result>,
  ): Promise<Result> => {
    let invocation: Promise<Result> | undefined;
    const pacingSlot = pacingTail.then(async () => {
      const currentTime = now();
      const invocationAt = Math.max(currentTime, nextInvocationAt);
      const delayMs = invocationAt - currentTime;
      if (delayMs >= 1) {
        await sleep(delayMs);
      }
      nextInvocationAt = invocationAt + intervalMs;
      lastScheduledInvocationAt = invocationAt;
      invocation = fn();
    });
    pacingTail = pacingSlot.catch(() => undefined);
    await pacingSlot;
    return await invocation!;
  };

  return {
    run: async <Result>(fn: () => Promise<Result>): Promise<Result> => {
      for (let retryCount = 0; ; retryCount += 1) {
        try {
          return await invokeWhenReady(fn);
        } catch (error) {
          if (!isRateLimitError(error) || retryCount >= maxRetries) {
            throw error;
          }

          const jitterCeilingMs = Math.min(
            maxDelayMs,
            baseDelayMs * 2 ** retryCount,
          );
          const retryAfterMs = readRetryAfterMs(error);
          const retryDelayMs = Math.max(
            retryAfterMs ?? 0,
            Math.random() * jitterCeilingMs,
          );
          if (retryDelayMs > 0) {
            await sleep(retryDelayMs);
          }
        }
      }
    },
    setRequestsPerSecond: (nextRequestsPerSecond) => {
      const nextIntervalMs = calculateIntervalMs(nextRequestsPerSecond);
      const currentTime = now();
      nextInvocationAt =
        lastScheduledInvocationAt === undefined
          ? currentTime
          : Math.max(currentTime, lastScheduledInvocationAt + nextIntervalMs);
      intervalMs = nextIntervalMs;
    },
  };
}

function calculateIntervalMs(requestsPerSecond: number): number {
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) {
    throw new RangeError("requestsPerSecond must be a positive finite number.");
  }

  return 1_000 / requestsPerSecond;
}

function defaultNow(): number {
  return Number(readHighResolutionTime()) / 1_000_000;
}

function readRetryAfterMs(error: unknown): number | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("retryAfterMs" in error) ||
    typeof error.retryAfterMs !== "number" ||
    !Number.isFinite(error.retryAfterMs) ||
    error.retryAfterMs < 0
  ) {
    return undefined;
  }

  return error.retryAfterMs;
}

function isRateLimitError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 429
  );
}

async function defaultSleep(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}
