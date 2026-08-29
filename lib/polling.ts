/**
 * Exponential backoff polling utility
 */

export interface PollingOptions {
  initialDelay?: number;
  maxDelay?: number;
  maxAttempts?: number;
  backoffMultiplier?: number;
  onAttempt?: (attempt: number) => void;
}

export class PollingController {
  private timeoutId: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;

  constructor(
    private callback: () => Promise<boolean>,
    private options: PollingOptions = {}
  ) {
    this.options = {
      initialDelay: 2000,
      maxDelay: 30000,
      maxAttempts: 100,
      backoffMultiplier: 1.5,
      ...options,
    };
  }

  start(): void {
    this.stopped = false;
    this.attempt = 0;
    this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;

    this.attempt++;

    if (this.options.maxAttempts && this.attempt > this.options.maxAttempts) {
      this.stop();
      return;
    }

    this.options.onAttempt?.(this.attempt);

    try {
      const shouldContinue = await this.callback();
      if (!shouldContinue) {
        this.stop();
        return;
      }
    } catch (error) {
      console.warn("Polling error:", error);
    }

    if (this.stopped) return;

    // Calculate next delay with exponential backoff
    const delay = Math.min(
      this.options.initialDelay! * Math.pow(this.options.backoffMultiplier!, this.attempt - 1),
      this.options.maxDelay!
    );

    this.timeoutId = setTimeout(() => this.poll(), delay);
  }
}
