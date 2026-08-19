import type { ToolDefinition } from "@harness/contracts";
import type {
  CategorizeTransactionsInput,
  CategorizeTransactionsOutput,
} from "@harness/contracts/tools";
import { CategorizeTransactionsInputSchema } from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";

// ---------------------------------------------------------------------------
// Built-in category rules (keyword → category)
// Evaluated in order; first match wins.
// ---------------------------------------------------------------------------

interface BuiltInRule {
  category: string;
  keywords: string[];
  /** If set, only matches positive amounts (credits). */
  creditOnly?: boolean;
}

const BUILT_IN_RULES: BuiltInRule[] = [
  // Income must come first so payroll credits aren't misclassified
  {
    category: "income",
    creditOnly: true,
    keywords: [
      "payroll",
      "salary",
      "deposit",
      "direct dep",
      "dividend",
      "interest",
      "refund",
      "cashback",
      "rebate",
    ],
  },
  {
    category: "housing",
    keywords: [
      "rent",
      "mortgage",
      "hoa",
      "property tax",
      "electricity",
      "gas bill",
      "water bill",
      "utility",
      "utilities",
      "home insurance",
      "renters insurance",
    ],
  },
  {
    category: "food",
    keywords: [
      "grocery",
      "groceries",
      "supermarket",
      "whole foods",
      "trader joe",
      "kroger",
      "safeway",
      "aldi",
      "lidl",
      "costco",
      "publix",
      "wegmans",
      "market basket",
      "food lion",
    ],
  },
  {
    category: "dining",
    keywords: [
      "restaurant",
      "cafe",
      "coffee",
      "starbucks",
      "doordash",
      "uber eats",
      "grubhub",
      "mcdonald",
      "burger",
      "pizza",
      "sushi",
      "taco",
      "chipotle",
      "subway",
      "domino",
      "dunkin",
      "panera",
      "chick-fil-a",
    ],
  },
  {
    category: "transport",
    keywords: [
      "uber *trip",
      "lyft",
      "taxi",
      "gas station",
      "shell",
      "bp ",
      "exxon",
      "chevron",
      "sunoco",
      "fuel",
      "metro",
      "transit",
      "train",
      "parking",
      "toll",
      "mta",
      "bart",
      "mbta",
    ],
  },
  {
    category: "healthcare",
    keywords: [
      "pharmacy",
      "cvs",
      "walgreens",
      "rite aid",
      "hospital",
      "clinic",
      "doctor",
      "dental",
      "dentist",
      "optician",
      "medical",
      "health",
      "copay",
      "urgent care",
      "lab corp",
      "quest diag",
    ],
  },
  {
    category: "entertainment",
    keywords: [
      "netflix",
      "spotify",
      "disney+",
      "hulu",
      "hbo",
      "amazon prime",
      "apple tv",
      "youtube premium",
      "cinema",
      "theater",
      "theatre",
      "concert",
      "ticketmaster",
      "eventbrite",
      "steam",
      "playstation",
      "xbox game",
      "nintendo",
    ],
  },
  {
    category: "shopping",
    keywords: [
      "amazon",
      "ebay",
      "etsy",
      "target",
      "walmart",
      "best buy",
      "apple store",
      "nike",
      "adidas",
      "zara",
      "h&m",
      "gap ",
      "old navy",
      "nordstrom",
      "macy",
      "tjmaxx",
      "marshalls",
      "ikea",
    ],
  },
  {
    category: "travel",
    keywords: [
      "hotel",
      "airbnb",
      "vrbo",
      "marriott",
      "hilton",
      "hyatt",
      "booking.com",
      "expedia",
      "airfare",
      "delta air",
      "united air",
      "southwest",
      "american air",
      "jetblue",
      "spirit air",
      "car rental",
      "hertz",
      "avis",
      "enterprise rent",
    ],
  },
  {
    category: "education",
    keywords: [
      "tuition",
      "university",
      "college",
      "coursera",
      "udemy",
      "skillshare",
      "linkedin learn",
      "duolingo",
      "school",
      "textbook",
    ],
  },
  {
    category: "subscriptions",
    keywords: [
      "subscription",
      "membership",
      "annual fee",
      "monthly fee",
      ".com/bill",
      "autopay",
      "auto pay",
    ],
  },
  {
    category: "financial",
    keywords: [
      "bank fee",
      "atm fee",
      "wire transfer",
      "loan payment",
      "credit card payment",
      "insurance premium",
      "brokerage",
      "fidelity",
      "schwab",
      "vanguard",
      "robinhood",
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ");
}

function matchCategory(
  description: string,
  amount: number,
  customRules: CategorizeTransactionsInput["customCategories"],
): string | null {
  const norm = normalise(description);
  const isCredit = amount > 0;
  const absAmt = Math.abs(amount);

  // Custom rules take precedence
  for (const rule of customRules) {
    const hit = rule.keywords.some((kw) => norm.includes(normalise(kw)));
    if (!hit) continue;
    if (rule.amountMin !== undefined && absAmt < rule.amountMin) continue;
    if (rule.amountMax !== undefined && absAmt > rule.amountMax) continue;
    return rule.name;
  }

  // Built-in rules (normalise keywords the same way as the description)
  for (const rule of BUILT_IN_RULES) {
    if (rule.creditOnly && !isCredit) continue;
    if (rule.keywords.some((kw) => norm.includes(normalise(kw)))) return rule.category;
  }

  return null;
}

function toYearMonth(date: string): string {
  return date.slice(0, 7); // "YYYY-MM"
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createCategorizeTransactionsTool(
  definition: ToolDefinition,
): Tool<CategorizeTransactionsInput, CategorizeTransactionsOutput> {
  return {
    definition,
    inputSchema: CategorizeTransactionsInputSchema,

    async execute(input) {
      const assumptions: string[] = [
        `Processing ${input.transactions.length} transaction(s).`,
        `${input.customCategories.length} custom category rule(s) applied before built-in rules.`,
      ];

      // Sort by date ascending for consistent processing
      const sorted = [...input.transactions].sort((a, b) => a.date.localeCompare(b.date));

      const periodFrom = sorted[0]?.date ?? "";
      const periodTo = sorted[sorted.length - 1]?.date ?? "";

      // Detect primary currency (most frequent)
      const currencyCount = new Map<string, number>();
      for (const t of sorted) {
        currencyCount.set(t.currency, (currencyCount.get(t.currency) ?? 0) + 1);
      }
      const currency = [...currencyCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";

      // Classify each transaction
      const catMap = new Map<string, { total: number; ids: string[] }>();
      const uncategorizedIds: string[] = [];
      let totalIncome = 0;
      let totalExpenses = 0;

      // Monthly aggregation
      const monthlyMap = new Map<
        string,
        { income: number; expenses: number; byCategory: Map<string, number> }
      >();

      for (const t of sorted) {
        const cat = matchCategory(t.description, t.amount, input.customCategories);
        const month = toYearMonth(t.date);

        if (!monthlyMap.has(month)) {
          monthlyMap.set(month, { income: 0, expenses: 0, byCategory: new Map() });
        }
        const monthData = monthlyMap.get(month)!;

        if (t.amount > 0) {
          totalIncome += t.amount;
          monthData.income += t.amount;
          const effectiveCat = cat ?? "income";
          const existing = catMap.get(effectiveCat) ?? { total: 0, ids: [] };
          existing.total += t.amount;
          existing.ids.push(t.id);
          catMap.set(effectiveCat, existing);
          const catTotal = monthData.byCategory.get(effectiveCat) ?? 0;
          monthData.byCategory.set(effectiveCat, catTotal + t.amount);
        } else {
          const absAmt = Math.abs(t.amount);
          totalExpenses += absAmt;
          monthData.expenses += absAmt;

          if (cat) {
            const existing = catMap.get(cat) ?? { total: 0, ids: [] };
            existing.total += absAmt;
            existing.ids.push(t.id);
            catMap.set(cat, existing);
            const catTotal = monthData.byCategory.get(cat) ?? 0;
            monthData.byCategory.set(cat, catTotal + absAmt);
          } else {
            uncategorizedIds.push(t.id);
          }
        }
      }

      // Build byCategory output
      const byCategory = [...catMap.entries()]
        .map(([category, { total, ids }]) => ({
          category,
          totalAmount: round2(total),
          transactionCount: ids.length,
          percentOfExpenses:
            totalExpenses > 0 && category !== "income" ? round2((total / totalExpenses) * 100) : 0,
          transactionIds: ids,
        }))
        .sort((a, b) => b.totalAmount - a.totalAmount);

      // Build monthly trend
      const monthlyTrend = [...monthlyMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, data]) => ({
          month,
          income: round2(data.income),
          expenses: round2(data.expenses),
          netFlow: round2(data.income - data.expenses),
          byCategory: Object.fromEntries(
            [...data.byCategory.entries()].map(([k, v]) => [k, round2(v)]),
          ),
        }));

      // Anomaly detection
      const anomalies: CategorizeTransactionsOutput["anomalies"] = [];

      // 1. Large single transactions: leave-one-out average per category
      //    Compute average excluding the transaction under review so that one
      //    outlier cannot inflate the baseline and hide itself.
      for (const t of sorted) {
        if (t.amount >= 0) continue;
        const absAmt = Math.abs(t.amount);
        const cat =
          matchCategory(t.description, t.amount, input.customCategories) ?? "uncategorized";
        const catEntry = catMap.get(cat);
        if (!catEntry || catEntry.ids.length < 2) continue;
        const avgExcluding = (catEntry.total - absAmt) / (catEntry.ids.length - 1);
        if (avgExcluding > 5 && absAmt > avgExcluding * 3) {
          anomalies.push({
            transactionId: t.id,
            reason: `${t.description}: $${absAmt.toFixed(2)} is ${(absAmt / avgExcluding).toFixed(1)}× the average for '${cat}'`,
            severity: absAmt > avgExcluding * 5 ? "alert" : "warning",
          });
        }
      }

      // 2. Flag duplicate same-day same-amount debits
      const seenKey = new Set<string>();
      for (const t of sorted) {
        if (t.amount >= 0) continue;
        const key = `${t.date}|${t.amount}|${normalise(t.description).slice(0, 20)}`;
        if (seenKey.has(key)) {
          anomalies.push({
            transactionId: t.id,
            reason: "Possible duplicate: same date, amount, and merchant as another transaction",
            severity: "warning",
          });
        }
        seenKey.add(key);
      }

      assumptions.push(`Period: ${periodFrom} to ${periodTo}`);
      assumptions.push(
        `${uncategorizedIds.length} transaction(s) could not be matched to any category`,
      );

      return {
        summary: {
          totalIncome: round2(totalIncome),
          totalExpenses: round2(totalExpenses),
          netFlow: round2(totalIncome - totalExpenses),
          currency,
          periodFrom,
          periodTo,
        },
        byCategory,
        uncategorizedIds,
        monthlyTrend,
        anomalies,
        assumptions,
      };
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
