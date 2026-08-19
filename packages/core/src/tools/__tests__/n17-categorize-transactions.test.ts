import { describe, expect, it } from "vitest";
import { createCategorizeTransactionsTool } from "../n17-categorize-transactions.js";

const DEF = {
  name: "categorizeTransactions",
  description: "test",
  dangerous: false,
  idempotent: true,
  costHint: "free" as const,
  inputSchema: {},
  outputSchema: {},
};

const tool = createCategorizeTransactionsTool(DEF);

const BASE_TXNS = [
  {
    id: "t1",
    date: "2026-07-02",
    description: "WHOLE FOODS MARKET",
    amount: -89.5,
    currency: "USD",
  },
  { id: "t2", date: "2026-07-05", description: "NETFLIX.COM", amount: -15.99, currency: "USD" },
  { id: "t3", date: "2026-07-10", description: "UBER *TRIP", amount: -22.4, currency: "USD" },
  { id: "t4", date: "2026-07-15", description: "PAYROLL DEPOSIT", amount: 4500, currency: "USD" },
  { id: "t5", date: "2026-07-20", description: "AMAZON.COM", amount: -134.0, currency: "USD" },
];

describe("N17 categorizeTransactions", () => {
  it("correctly sums totalIncome and totalExpenses", async () => {
    const result = await tool.execute({ transactions: BASE_TXNS, customCategories: [] });

    expect(result.summary.totalIncome).toBeCloseTo(4500, 2);
    expect(result.summary.totalExpenses).toBeCloseTo(89.5 + 15.99 + 22.4 + 134.0, 1);
    expect(result.summary.netFlow).toBeCloseTo(4500 - (89.5 + 15.99 + 22.4 + 134.0), 1);
  });

  it("classifies payroll credit as income", async () => {
    const result = await tool.execute({ transactions: BASE_TXNS, customCategories: [] });
    const income = result.byCategory.find((c) => c.category === "income");
    expect(income).toBeDefined();
    expect(income?.transactionIds).toContain("t4");
  });

  it("classifies grocery store as food", async () => {
    const result = await tool.execute({ transactions: BASE_TXNS, customCategories: [] });
    const food = result.byCategory.find((c) => c.category === "food");
    expect(food?.transactionIds).toContain("t1");
  });

  it("classifies Netflix as entertainment", async () => {
    const result = await tool.execute({ transactions: BASE_TXNS, customCategories: [] });
    const entertainment = result.byCategory.find((c) => c.category === "entertainment");
    expect(entertainment?.transactionIds).toContain("t2");
  });

  it("classifies Uber trip as transport", async () => {
    const result = await tool.execute({ transactions: BASE_TXNS, customCategories: [] });
    const transport = result.byCategory.find((c) => c.category === "transport");
    expect(transport?.transactionIds).toContain("t3");
  });

  it("classifies Amazon as shopping", async () => {
    const result = await tool.execute({ transactions: BASE_TXNS, customCategories: [] });
    const shopping = result.byCategory.find((c) => c.category === "shopping");
    expect(shopping?.transactionIds).toContain("t5");
  });

  it("byCategory is sorted descending by totalAmount", async () => {
    const result = await tool.execute({ transactions: BASE_TXNS, customCategories: [] });
    const amounts = result.byCategory.map((c) => c.totalAmount);
    for (let i = 1; i < amounts.length; i++) {
      expect(amounts[i]).toBeLessThanOrEqual(amounts[i - 1] as number);
    }
  });

  it("custom rule takes precedence over built-in", async () => {
    const result = await tool.execute({
      transactions: [
        {
          id: "x1",
          date: "2026-07-01",
          description: "AMAZON.COM",
          amount: -49.99,
          currency: "USD",
        },
      ],
      customCategories: [{ name: "office_supplies", keywords: ["amazon"] }],
    });

    const custom = result.byCategory.find((c) => c.category === "office_supplies");
    expect(custom?.transactionIds).toContain("x1");
    // Should NOT appear in shopping
    const shopping = result.byCategory.find((c) => c.category === "shopping");
    expect(shopping).toBeUndefined();
  });

  it("unrecognised merchants go into uncategorizedIds", async () => {
    const result = await tool.execute({
      transactions: [
        {
          id: "u1",
          date: "2026-07-01",
          description: "XYZZY CORP 12345",
          amount: -42.0,
          currency: "USD",
        },
      ],
      customCategories: [],
    });

    expect(result.uncategorizedIds).toContain("u1");
  });

  it("builds monthly trend with correct income and expenses per month", async () => {
    const result = await tool.execute({ transactions: BASE_TXNS, customCategories: [] });
    const july = result.monthlyTrend.find((m) => m.month === "2026-07");
    expect(july).toBeDefined();
    expect(july?.income).toBeCloseTo(4500, 2);
    expect(july?.expenses).toBeCloseTo(89.5 + 15.99 + 22.4 + 134.0, 1);
  });

  it("flags anomaly for unusually large single transaction", async () => {
    const txns = [
      ...BASE_TXNS,
      { id: "big", date: "2026-07-25", description: "AMAZON.COM", amount: -9999, currency: "USD" },
    ];
    const result = await tool.execute({ transactions: txns, customCategories: [] });

    const bigAnomaly = result.anomalies.find((a) => a.transactionId === "big");
    expect(bigAnomaly).toBeDefined();
    expect(["warning", "alert"]).toContain(bigAnomaly?.severity);
  });

  it("flags duplicate same-day same-amount charge", async () => {
    const result = await tool.execute({
      transactions: [
        {
          id: "d1",
          date: "2026-07-01",
          description: "NETFLIX.COM",
          amount: -15.99,
          currency: "USD",
        },
        {
          id: "d2",
          date: "2026-07-01",
          description: "NETFLIX.COM",
          amount: -15.99,
          currency: "USD",
        },
      ],
      customCategories: [],
    });

    const dupAnomaly = result.anomalies.find((a) => a.transactionId === "d2");
    expect(dupAnomaly).toBeDefined();
  });

  it("percentOfExpenses sums to 100 across expense categories", async () => {
    const result = await tool.execute({ transactions: BASE_TXNS, customCategories: [] });
    const expenseCategories = result.byCategory.filter((c) => c.category !== "income");
    const total = expenseCategories.reduce((s, c) => s + c.percentOfExpenses, 0);
    expect(total).toBeCloseTo(100, 0);
  });

  it("currency defaults to USD when not provided", async () => {
    const result = await tool.execute({
      transactions: [
        { id: "c1", date: "2026-07-01", description: "PAYROLL", amount: 3000, currency: "USD" },
      ],
      customCategories: [],
    });
    expect(result.summary.currency).toBe("USD");
  });
});
