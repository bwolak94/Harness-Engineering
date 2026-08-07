import { type Result, err, ok } from "./result.js";

/**
 * TokenCount — non-negative integer representing LLM tokens consumed.
 * Invariant: value >= 0 and is an integer.
 */
export class TokenCount {
  private constructor(readonly value: number) {}

  static create(n: number): Result<TokenCount, string> {
    if (!Number.isInteger(n) || n < 0) {
      return err(`TokenCount must be a non-negative integer, got ${n}`);
    }
    return ok(new TokenCount(n));
  }

  static zero(): TokenCount {
    return new TokenCount(0);
  }

  add(other: TokenCount): TokenCount {
    return new TokenCount(this.value + other.value);
  }

  exceeds(limit: TokenCount): boolean {
    return this.value > limit.value;
  }

  toString(): string {
    return `TokenCount(${this.value})`;
  }
}

/**
 * Cost — non-negative monetary amount with currency.
 * Invariant: amount >= 0.
 */
export class Cost {
  private constructor(
    readonly amount: number,
    readonly currency: string,
  ) {}

  static create(amount: number, currency: string): Result<Cost, string> {
    if (amount < 0) {
      return err(`Cost amount must be non-negative, got ${amount}`);
    }
    if (!currency || currency.length !== 3) {
      return err(`Cost currency must be a 3-character ISO 4217 code, got '${currency}'`);
    }
    return ok(new Cost(amount, currency.toUpperCase()));
  }

  static zero(currency = "USD"): Cost {
    return new Cost(0, currency);
  }

  add(other: Cost): Result<Cost, string> {
    if (this.currency !== other.currency) {
      return err(
        `Cannot add Cost with different currencies: ${this.currency} vs ${other.currency}`,
      );
    }
    return ok(new Cost(this.amount + other.amount, this.currency));
  }

  exceeds(limit: Cost): Result<boolean, string> {
    if (this.currency !== limit.currency) {
      return err("Cannot compare Cost with different currencies");
    }
    return ok(this.amount > limit.amount);
  }

  toString(): string {
    return `Cost(${this.amount} ${this.currency})`;
  }
}

/**
 * StepIndex — zero-based non-negative integer step counter.
 * Invariant: value >= 0 and is an integer.
 */
export class StepIndex {
  private constructor(readonly value: number) {}

  static create(n: number): Result<StepIndex, string> {
    if (!Number.isInteger(n) || n < 0) {
      return err(`StepIndex must be a non-negative integer, got ${n}`);
    }
    return ok(new StepIndex(n));
  }

  static zero(): StepIndex {
    return new StepIndex(0);
  }

  next(): StepIndex {
    return new StepIndex(this.value + 1);
  }

  exceeds(limit: StepIndex): boolean {
    return this.value > limit.value;
  }

  toString(): string {
    return `StepIndex(${this.value})`;
  }
}
