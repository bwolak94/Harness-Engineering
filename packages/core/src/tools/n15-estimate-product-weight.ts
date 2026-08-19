import type { ToolDefinition } from "@harness/contracts";
import type {
  EstimateProductWeightInput,
  EstimateProductWeightOutput,
} from "@harness/contracts/tools";
import { EstimateProductWeightInputSchema } from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";

export function createEstimateProductWeightTool(
  definition: ToolDefinition,
): Tool<EstimateProductWeightInput, EstimateProductWeightOutput> {
  return {
    definition,
    inputSchema: EstimateProductWeightInputSchema,

    async execute(input) {
      const assumptions: string[] = [];

      // ----- Per-component totals -----
      const totalProductWeightGrams = input.components.reduce(
        (sum, c) => sum + c.quantity * c.massGrams,
        0,
      );

      assumptions.push(
        `Total product mass = sum of ${input.components.length} component type(s): ${totalProductWeightGrams.toFixed(2)} g`,
      );

      // ----- Component breakdown (sorted descending by total mass) -----
      const componentBreakdown: EstimateProductWeightOutput["componentBreakdown"] = input.components
        .map((c) => {
          const totalMassGrams = c.quantity * c.massGrams;
          const percentOfProductWeight =
            totalProductWeightGrams > 0 ? (totalMassGrams / totalProductWeightGrams) * 100 : 0;
          return {
            id: c.id,
            name: c.name,
            category: c.category,
            quantity: c.quantity,
            unitMassGrams: c.massGrams,
            totalMassGrams: round2(totalMassGrams),
            percentOfProductWeight: round2(percentOfProductWeight),
          };
        })
        .sort((a, b) => b.totalMassGrams - a.totalMassGrams);

      // ----- Category breakdown -----
      const categoryMap = new Map<string, { totalMassGrams: number; componentCount: number }>();

      for (const c of input.components) {
        const existing = categoryMap.get(c.category) ?? { totalMassGrams: 0, componentCount: 0 };
        categoryMap.set(c.category, {
          totalMassGrams: existing.totalMassGrams + c.quantity * c.massGrams,
          componentCount: existing.componentCount + 1,
        });
      }

      const categoryBreakdown: EstimateProductWeightOutput["categoryBreakdown"] = Array.from(
        categoryMap.entries(),
      )
        .map(([category, { totalMassGrams, componentCount }]) => ({
          category,
          totalMassGrams: round2(totalMassGrams),
          percentOfProductWeight: round2(
            totalProductWeightGrams > 0 ? (totalMassGrams / totalProductWeightGrams) * 100 : 0,
          ),
          componentCount,
        }))
        .sort((a, b) => b.totalMassGrams - a.totalMassGrams);

      for (const cat of categoryBreakdown) {
        assumptions.push(
          `Category '${cat.category}': ${cat.totalMassGrams} g (${cat.percentOfProductWeight.toFixed(1)}%)`,
        );
      }

      // ----- Shipping weight -----
      const packagingWeightGrams = input.packagingMassGrams;
      const shippingWeightGrams = totalProductWeightGrams + packagingWeightGrams;

      if (packagingWeightGrams > 0) {
        assumptions.push(
          `Packaging: ${packagingWeightGrams} g → shipping weight: ${shippingWeightGrams.toFixed(2)} g`,
        );
      }

      // ----- Target check -----
      let targetMet: boolean | null = null;
      let overageGrams: number | null = null;

      if (input.targetMaxWeightGrams !== undefined) {
        const overage = totalProductWeightGrams - input.targetMaxWeightGrams;
        overageGrams = round2(overage);
        targetMet = overage <= 0;

        if (targetMet) {
          assumptions.push(
            `Weight budget met: ${totalProductWeightGrams.toFixed(2)} g ≤ ${input.targetMaxWeightGrams} g ` +
              `(${Math.abs(overage).toFixed(2)} g margin remaining)`,
          );
        } else {
          assumptions.push(
            `Weight budget EXCEEDED: ${totalProductWeightGrams.toFixed(2)} g > ${input.targetMaxWeightGrams} g ` +
              `(${overage.toFixed(2)} g over budget)`,
          );
        }
      }

      // ----- Heaviest contributors (top 5) -----
      const heaviestComponents = componentBreakdown.slice(0, 5).map((c) => c.name);

      return {
        totalProductWeightGrams: round2(totalProductWeightGrams),
        componentBreakdown,
        categoryBreakdown,
        packagingWeightGrams: round2(packagingWeightGrams),
        shippingWeightGrams: round2(shippingWeightGrams),
        targetMet,
        overageGrams,
        heaviestComponents,
        assumptions,
      };
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
