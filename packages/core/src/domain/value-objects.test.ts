import { describe, expect, it } from "vitest";
import { isErr, isOk } from "./result.js";
import { Cost, StepIndex, TokenCount } from "./value-objects.js";

describe("TokenCount", () => {
  it("creates with valid non-negative integer", () => {
    const r = TokenCount.create(100);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.value).toBe(100);
  });

  it("zero() creates TokenCount(0)", () => {
    expect(TokenCount.zero().value).toBe(0);
  });

  it("rejects negative values", () => {
    expect(isErr(TokenCount.create(-1))).toBe(true);
  });

  it("rejects floats", () => {
    expect(isErr(TokenCount.create(1.5))).toBe(true);
  });

  it("add() sums values", () => {
    const a = TokenCount.create(10);
    const b = TokenCount.create(20);
    if (isOk(a) && isOk(b)) {
      expect(a.value.add(b.value).value).toBe(30);
    }
  });

  it("exceeds() compares correctly", () => {
    const a = TokenCount.create(100);
    const b = TokenCount.create(50);
    if (isOk(a) && isOk(b)) {
      expect(a.value.exceeds(b.value)).toBe(true);
      expect(b.value.exceeds(a.value)).toBe(false);
    }
  });
});

describe("Cost", () => {
  it("creates with valid amount and currency", () => {
    const r = Cost.create(9.99, "USD");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.amount).toBe(9.99);
      expect(r.value.currency).toBe("USD");
    }
  });

  it("zero() creates Cost(0, USD)", () => {
    const z = Cost.zero();
    expect(z.amount).toBe(0);
    expect(z.currency).toBe("USD");
  });

  it("rejects negative amount", () => {
    expect(isErr(Cost.create(-1, "USD"))).toBe(true);
  });

  it("rejects invalid currency", () => {
    expect(isErr(Cost.create(1, "US"))).toBe(true);
    expect(isErr(Cost.create(1, ""))).toBe(true);
  });

  it("add() works for same currency", () => {
    const a = Cost.create(1.0, "USD");
    const b = Cost.create(2.5, "USD");
    if (isOk(a) && isOk(b)) {
      const sum = a.value.add(b.value);
      expect(isOk(sum)).toBe(true);
      if (isOk(sum)) expect(sum.value.amount).toBeCloseTo(3.5);
    }
  });

  it("add() errors for different currencies", () => {
    const a = Cost.create(1.0, "USD");
    const b = Cost.create(1.0, "EUR");
    if (isOk(a) && isOk(b)) {
      expect(isErr(a.value.add(b.value))).toBe(true);
    }
  });

  it("normalises currency to upper-case", () => {
    const r = Cost.create(1, "usd");
    if (isOk(r)) expect(r.value.currency).toBe("USD");
  });
});

describe("StepIndex", () => {
  it("creates with valid value", () => {
    const r = StepIndex.create(5);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.value).toBe(5);
  });

  it("zero() is 0", () => {
    expect(StepIndex.zero().value).toBe(0);
  });

  it("next() increments", () => {
    expect(StepIndex.zero().next().value).toBe(1);
  });

  it("rejects negative", () => {
    expect(isErr(StepIndex.create(-1))).toBe(true);
  });

  it("rejects float", () => {
    expect(isErr(StepIndex.create(1.1))).toBe(true);
  });

  it("exceeds() compares correctly", () => {
    const a = StepIndex.create(3);
    const b = StepIndex.create(10);
    if (isOk(a) && isOk(b)) {
      expect(a.value.exceeds(b.value)).toBe(false);
      expect(b.value.exceeds(a.value)).toBe(true);
    }
  });
});
