import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PollingController } from "@/lib/polling";

describe("PollingController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should poll with exponential backoff", async () => {
    const callback = vi.fn().mockResolvedValue(true);
    const controller = new PollingController(callback, {
      initialDelay: 1000,
      maxDelay: 10000,
      backoffMultiplier: 2,
    });

    controller.start();

    // First attempt is immediate: start() invokes poll() synchronously,
    // so the callback has already fired before any timer is pending.
    expect(callback).toHaveBeenCalledTimes(1);

    // Second attempt - 1000ms delay (initialDelay * multiplier^0)
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledTimes(2);

    // Third attempt - 2000ms delay (1000 * 2^1)
    await vi.advanceTimersByTimeAsync(2000);
    expect(callback).toHaveBeenCalledTimes(3);

    // Fourth attempt - 4000ms delay (1000 * 2^2)
    await vi.advanceTimersByTimeAsync(4000);
    expect(callback).toHaveBeenCalledTimes(4);

    controller.stop();
  });

  it("should stop polling when callback returns false", async () => {
    const callback = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const controller = new PollingController(callback, {
      initialDelay: 1000,
    });

    controller.start();

    // First attempt is immediate (synchronous inside start())
    expect(callback).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledTimes(2);

    // Should not poll again
    await vi.advanceTimersByTimeAsync(10000);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("should respect maxAttempts", async () => {
    const callback = vi.fn().mockResolvedValue(true);
    const controller = new PollingController(callback, {
      initialDelay: 100,
      maxAttempts: 3,
    });

    controller.start();

    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(1000);

    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("should call onAttempt callback", async () => {
    const callback = vi.fn().mockResolvedValue(true);
    const onAttempt = vi.fn();
    const controller = new PollingController(callback, {
      initialDelay: 100,
      maxAttempts: 2,
      onAttempt,
    });

    controller.start();

    await vi.runOnlyPendingTimersAsync();
    expect(onAttempt).toHaveBeenCalledWith(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(onAttempt).toHaveBeenCalledWith(2);

    controller.stop();
  });

  it("should handle errors and continue polling", async () => {
    const callback = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValue(true);

    const controller = new PollingController(callback, {
      initialDelay: 100,
    });

    controller.start();

    // First attempt is immediate (synchronous inside start()) and rejects
    expect(callback).toHaveBeenCalledTimes(1);

    // Should continue polling despite the rejected first attempt
    await vi.advanceTimersByTimeAsync(100);
    expect(callback).toHaveBeenCalledTimes(2);

    controller.stop();
  });
});
