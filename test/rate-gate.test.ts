import { afterEach, describe, expect, test, vi } from "vitest";
import { createRateGate } from "../src/connectors/rate-gate.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Rate gate", () => {
  test("spaces invocations at the configured steady-state rate", async () => {
    const clock = createFakeClock(1_000);
    const starts: number[] = [];
    const gate = createRateGate({
      now: clock.now,
      requestsPerSecond: 4,
      sleep: clock.sleep,
    });

    await Promise.all(
      Array.from({ length: 4 }, () =>
        gate.run(() => {
          starts.push(clock.now());
          return Promise.resolve();
        }),
      ),
    );

    expect(starts).toEqual([1_000, 1_250, 1_500, 1_750]);
  });

  test("retries 429 responses with exponentially growing full jitter", async () => {
    const clock = createFakeClock();
    const request = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("limited"), { status: 429 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("limited"), { status: 429 }),
      )
      .mockResolvedValue("ok");
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const gate = createRateGate({
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      maxRetries: 2,
      now: clock.now,
      requestsPerSecond: 1_000,
      sleep: clock.sleep,
    });

    await expect(gate.run(request)).resolves.toBe("ok");
    expect(request).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([50, 100]);
  });

  test("honors a retryAfterMs hint on a 429 error", async () => {
    const clock = createFakeClock();
    const request = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("limited"), {
          retryAfterMs: 750,
          status: 429,
        }),
      )
      .mockResolvedValue("ok");
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const gate = createRateGate({
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      now: clock.now,
      requestsPerSecond: 1_000,
      sleep: clock.sleep,
    });

    await expect(gate.run(request)).resolves.toBe("ok");
    expect(clock.sleeps).toEqual([750]);
  });

  test("propagates a non-429 error without retrying", async () => {
    const failure = Object.assign(new Error("forbidden"), { status: 403 });
    const request = vi.fn<() => Promise<void>>().mockRejectedValue(failure);
    const gate = createRateGate({ requestsPerSecond: 1_000 });

    await expect(gate.run(request)).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("rethrows the last 429 when retries are exhausted", async () => {
    const clock = createFakeClock();
    const firstFailure = Object.assign(new Error("first"), { status: 429 });
    const lastFailure = Object.assign(new Error("last"), { status: 429 });
    const request = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(firstFailure)
      .mockRejectedValueOnce(lastFailure);
    const gate = createRateGate({
      baseDelayMs: 1,
      maxRetries: 1,
      now: clock.now,
      requestsPerSecond: 1_000,
      sleep: clock.sleep,
    });

    await expect(gate.run(request)).rejects.toBe(lastFailure);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

function createFakeClock(start = 0): {
  now: () => number;
  sleep: (durationMs: number) => Promise<void>;
  sleeps: number[];
} {
  let time = start;
  const sleeps: number[] = [];

  return {
    now: () => time,
    sleep: (durationMs) => {
      sleeps.push(durationMs);
      time += durationMs;
      return Promise.resolve();
    },
    sleeps,
  };
}
