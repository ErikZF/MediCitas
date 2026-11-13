// Stops talking to Redis for a while after it fails, so a slow or dead Redis never
// slows down availability: requests go straight to PostgreSQL instead.
//
//   closed     normal; every call goes to Redis
//   open       Redis is skipped until `openMs` have passed
//   half-open  the next call is a probe: success closes, failure opens again

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  /** Consecutive failures that open the breaker. */
  failureThreshold: number;
  /** How long it stays open before a probe is allowed. */
  openMs: number;
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  // Plain fields, not parameter properties: Node runs this file by stripping types only.
  private readonly options: BreakerOptions;
  private readonly now: () => number;

  constructor(options: BreakerOptions = { failureThreshold: 3, openMs: 5000 }, now: () => number = Date.now) {
    this.options = options;
    this.now = now;
  }

  get current(): BreakerState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.options.openMs) {
      this.state = 'half-open';
    }
    return this.state;
  }

  /** May this call go to Redis? */
  allows(): boolean {
    return this.current !== 'open';
  }

  succeeded(): void {
    this.state = 'closed';
    this.failures = 0;
  }

  failed(): void {
    this.failures += 1;
    if (this.current === 'half-open' || this.failures >= this.options.failureThreshold) {
      this.trip();
    }
  }

  /** Opens at once, whatever the count: used when an invalidation is lost. */
  trip(): void {
    this.state = 'open';
    this.openedAt = this.now();
  }
}
