import type { ToolDefinition } from "@harness/contracts";
import type {
  BomComponent,
  EstimateProductionCostInput,
  EstimateProductionCostOutput,
} from "@harness/contracts/tools";
import { EstimateProductionCostInputSchema } from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the effective unit cost for a component at a given production volume.
 * The volume discount is applied to `unitCostBase` using the highest matching bracket.
 * Brackets are expected to be sorted ascending by minQty but we find the best match
 * without assuming order.
 */
function effectiveUnitCost(component: BomComponent, productionVolume: number): number {
  // Total component quantity ordered for this production run
  const orderQty = component.quantity * productionVolume;

  let bestDiscount = 0;
  for (const bracket of component.volumeDiscounts) {
    if (orderQty >= bracket.minQty && bracket.discountPct > bestDiscount) {
      bestDiscount = bracket.discountPct;
    }
  }

  return component.unitCostBase * (1 - bestDiscount / 100);
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createEstimateProductionCostTool(
  definition: ToolDefinition,
): Tool<EstimateProductionCostInput, EstimateProductionCostOutput> {
  return {
    definition,
    inputSchema: EstimateProductionCostInputSchema,

    async execute(input) {
      const assumptions: string[] = [];
      const laborCostPerUnit = input.labor.hoursPerUnit * input.labor.hourlyRate;

      assumptions.push(
        `Labour: ${input.labor.hoursPerUnit} h/unit × ${input.labor.hourlyRate}/h = ${laborCostPerUnit.toFixed(4)}/unit`,
      );
      assumptions.push(`Overhead rate: ${input.overheadPct}% of (material + labour)`);

      if (input.toolingFixedCost > 0) {
        assumptions.push(`Tooling fixed cost: ${input.toolingFixedCost} (amortised per volume)`);
      }

      // Sorted volumes for consistent output ordering
      const volumes = [...input.productionVolumes].sort((a, b) => a - b);

      const volumeBreakdown: EstimateProductionCostOutput["volumeBreakdown"] = [];

      for (const volume of volumes) {
        // ----- Material cost at this volume -----
        let materialCostPerUnit = 0;
        for (const component of input.bom) {
          const unitCost = effectiveUnitCost(component, volume);
          const componentContribution = component.quantity * unitCost;
          materialCostPerUnit += componentContribution;

          const orderQty = component.quantity * volume;
          const originalTotal = component.quantity * component.unitCostBase;
          if (unitCost < component.unitCostBase) {
            assumptions.push(
              `V=${volume} | ${component.name}: order ${orderQty} units → ` +
                `discount applied, cost ${originalTotal.toFixed(4)} → ${componentContribution.toFixed(4)}/product-unit`,
            );
          }
        }

        const overheadCostPerUnit = (materialCostPerUnit + laborCostPerUnit) * (input.overheadPct / 100);
        const toolingAmortizedPerUnit = input.toolingFixedCost > 0 ? input.toolingFixedCost / volume : 0;

        const unitCostTotal =
          materialCostPerUnit + laborCostPerUnit + overheadCostPerUnit + toolingAmortizedPerUnit;

        assumptions.push(
          `V=${volume}: material=${materialCostPerUnit.toFixed(4)}, labour=${laborCostPerUnit.toFixed(4)}, ` +
            `overhead=${overheadCostPerUnit.toFixed(4)}, tooling=${toolingAmortizedPerUnit.toFixed(4)}, ` +
            `total=${unitCostTotal.toFixed(4)}`,
        );

        let grossMarginPct: number | undefined;
        if (input.targetRetailPrice !== undefined) {
          grossMarginPct = ((input.targetRetailPrice - unitCostTotal) / input.targetRetailPrice) * 100;
        }

        const row: EstimateProductionCostOutput["volumeBreakdown"][number] = {
          volume,
          materialCostPerUnit: round4(materialCostPerUnit),
          laborCostPerUnit: round4(laborCostPerUnit),
          overheadCostPerUnit: round4(overheadCostPerUnit),
          toolingAmortizedPerUnit: round4(toolingAmortizedPerUnit),
          unitCostTotal: round4(unitCostTotal),
        };

        if (grossMarginPct !== undefined) {
          row.grossMarginPct = round4(grossMarginPct);
        }

        volumeBreakdown.push(row);
      }

      // ----- Minimum viable volume (50% gross margin floor) -----
      let minimumViableVolume: number | undefined;
      if (input.targetRetailPrice !== undefined) {
        const marginFloor = input.targetRetailPrice * 0.5;
        // Find first volume where unitCostTotal ≤ 50% of retail price
        const viable = volumeBreakdown.find((r) => r.unitCostTotal <= marginFloor);
        if (viable) {
          minimumViableVolume = viable.volume;
          assumptions.push(
            `Minimum viable volume (≥50% gross margin): ${minimumViableVolume} units ` +
              `(unit cost ${viable.unitCostTotal.toFixed(4)} ≤ ${marginFloor.toFixed(4)})`,
          );
        } else {
          assumptions.push(
            `No volume in the provided list achieves ≥50% gross margin at retail price ${input.targetRetailPrice}`,
          );
        }
      }

      return { volumeBreakdown, minimumViableVolume, assumptions };
    },
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
