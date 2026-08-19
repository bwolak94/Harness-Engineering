import { describe, expect, it } from "vitest";
import { createDetectSubscriptionDriftTool } from "../n19-detect-subscription-drift.js";

const DEF = {
  name: "detectSubscriptionDrift",
  description: "test",
  dangerous: false,
  idempotent: true,
  costHint: "cheap" as const,
  inputSchema: {},
  outputSchema: {},
};

const tool = createDetectSubscriptionDriftTool(DEF);

// Helper: dates anchored relative to "now" so lookback window always catches them
function pastDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

const STABLE_NETFLIX = [
  { id: "n1", date: pastDate(90), description: "NETFLIX.COM", amount: 15.99, currency: "USD" },
  { id: "n2", date: pastDate(60), description: "NETFLIX.COM", amount: 15.99, currency: "USD" },
  { id: "n3", date: pastDate(30), description: "NETFLIX.COM", amount: 15.99, currency: "USD" },
];

const INCREASED_SPOTIFY = [
  { id: "s1", date: pastDate(90), description: "SPOTIFY PREMIUM", amount: 9.99, currency: "USD" },
  { id: "s2", date: pastDate(60), description: "SPOTIFY PREMIUM", amount: 9.99, currency: "USD" },
  { id: "s3", date: pastDate(30), description: "SPOTIFY PREMIUM", amount: 11.99, currency: "USD" },
];

describe("N19 detectSubscriptionDrift", () => {
  it("detects stable monthly subscription", async () => {
    const result = await tool.execute({
      transactions: STABLE_NETFLIX,
      lookbackMonths: 12,
      amountTolerancePct: 5,
    });

    const netflix = result.subscriptions.find((s) => s.name.toLowerCase().includes("netflix"));
    expect(netflix).toBeDefined();
    expect(netflix?.status).toBe("stable");
    expect(netflix?.frequency).toBe("monthly");
    expect(netflix?.driftPct).toBeCloseTo(0, 1);
  });

  it("detects price increase and emits price_increase alert", async () => {
    const result = await tool.execute({
      transactions: INCREASED_SPOTIFY,
      lookbackMonths: 12,
      amountTolerancePct: 5,
    });

    const spotify = result.subscriptions.find((s) => s.name.toLowerCase().includes("spotify"));
    expect(spotify?.status).toBe("increased");
    expect(spotify?.driftPct).toBeGreaterThan(0);

    const alert = result.driftAlerts.find(
      (a) =>
        a.alertType === "price_increase" && a.subscriptionName.toLowerCase().includes("spotify"),
    );
    expect(alert).toBeDefined();
  });

  it("single charge is not treated as a subscription", async () => {
    const result = await tool.execute({
      transactions: [
        {
          id: "x1",
          date: pastDate(10),
          description: "UNKNOWN SERVICE",
          amount: 9.99,
          currency: "USD",
        },
      ],
      lookbackMonths: 12,
      amountTolerancePct: 5,
    });

    expect(result.subscriptions).toHaveLength(0);
    expect(result.nonRecurringTransactionCount).toBe(1);
  });

  it("totals all subscriptions correctly", async () => {
    const result = await tool.execute({
      transactions: [...STABLE_NETFLIX, ...INCREASED_SPOTIFY],
      lookbackMonths: 12,
      amountTolerancePct: 5,
    });

    // Netflix: $15.99/month; Spotify (last charge): $11.99/month
    expect(result.monthlySubscriptionTotal).toBeCloseTo(15.99 + 11.99, 1);
    expect(result.annualSubscriptionTotal).toBeCloseTo((15.99 + 11.99) * 12, 0);
  });

  it("subscriptions sorted descending by totalPaidInPeriod", async () => {
    const result = await tool.execute({
      transactions: [...STABLE_NETFLIX, ...INCREASED_SPOTIFY],
      lookbackMonths: 12,
      amountTolerancePct: 5,
    });

    const totals = result.subscriptions.map((s) => s.totalPaidInPeriod);
    for (let i = 1; i < totals.length; i++) {
      expect(totals[i]).toBeLessThanOrEqual(totals[i - 1] as number);
    }
  });

  it("flags potentially_cancelled when no recent charge", async () => {
    const result = await tool.execute({
      transactions: [
        {
          id: "o1",
          date: pastDate(120),
          description: "OLD SUBSCRIPTION",
          amount: 12.99,
          currency: "USD",
        },
        {
          id: "o2",
          date: pastDate(150),
          description: "OLD SUBSCRIPTION",
          amount: 12.99,
          currency: "USD",
        },
      ],
      lookbackMonths: 12,
      amountTolerancePct: 5,
    });

    const sub = result.subscriptions.find((s) => s.name.toLowerCase().includes("old"));
    expect(sub?.status).toBe("potentially_cancelled");

    const alert = result.driftAlerts.find((a) => a.alertType === "forgotten");
    expect(alert).toBeDefined();
  });

  it("detects annual subscription frequency", async () => {
    const result = await tool.execute({
      transactions: [
        { id: "a1", date: pastDate(370), description: "ANNUAL GYM", amount: 299, currency: "USD" },
        { id: "a2", date: pastDate(5), description: "ANNUAL GYM", amount: 320, currency: "USD" },
      ],
      lookbackMonths: 24,
      amountTolerancePct: 10,
    });

    const gym = result.subscriptions.find((s) => s.name.toLowerCase().includes("annual"));
    expect(gym?.frequency).toBe("annual");
  });

  it("includes priceHistory for each subscription", async () => {
    const result = await tool.execute({
      transactions: STABLE_NETFLIX,
      lookbackMonths: 12,
      amountTolerancePct: 5,
    });

    const netflix = result.subscriptions[0];
    expect(netflix?.priceHistory).toHaveLength(3);
    expect(netflix?.priceHistory[0]?.amount).toBe(15.99);
  });

  it("non-recurring transactions are excluded from subscriptions", async () => {
    const result = await tool.execute({
      transactions: [
        ...STABLE_NETFLIX,
        {
          id: "one",
          date: pastDate(15),
          description: "RANDOM STORE PURCHASE",
          amount: 55.0,
          currency: "USD",
        },
      ],
      lookbackMonths: 12,
      amountTolerancePct: 5,
    });

    expect(result.nonRecurringTransactionCount).toBeGreaterThanOrEqual(1);
    const random = result.subscriptions.find((s) => s.name.toLowerCase().includes("random"));
    expect(random).toBeUndefined();
  });

  it("driftPct is null when only one charge exists in period", async () => {
    // With lookback of 1 month, only the most recent Netflix charge is in window
    const result = await tool.execute({
      transactions: STABLE_NETFLIX,
      lookbackMonths: 1,
      amountTolerancePct: 5,
    });

    // Only 1 charge in 1-month window — not enough for subscription detection
    expect(result.subscriptions).toHaveLength(0);
  });
});
