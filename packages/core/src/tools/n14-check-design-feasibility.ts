import type { ToolDefinition } from "@harness/contracts";
import type {
  CheckDesignFeasibilityInput,
  CheckDesignFeasibilityOutput,
  FeasibilityViolation,
} from "@harness/contracts/tools";
import { CheckDesignFeasibilityInputSchema } from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";

// ---------------------------------------------------------------------------
// IP rating helpers
// ---------------------------------------------------------------------------

/**
 * Parses "IP67" → { dust: 6, water: 7 }.
 * Returns null for malformed strings (schema already validates format).
 */
function parseIpRating(ip: string): { dust: number; water: number } | null {
  const match = /^IP(\d)(\d)$/.exec(ip);
  if (!match) return null;
  return { dust: Number(match[1]), water: Number(match[2]) };
}

/**
 * Returns true when `actual` meets or exceeds `required` on both IP axes.
 */
function ipMeetsRequirement(required: string, actual: string): boolean {
  const req = parseIpRating(required);
  const act = parseIpRating(actual);
  if (!req || !act) return false;
  return act.dust >= req.dust && act.water >= req.water;
}

/**
 * Find the highest IP rating achievable from a list of material IP capabilities.
 * Each axis (dust, water) is bottlenecked by the *worst* material that contributes.
 * If no materials have IP data, returns null.
 */
function resolveDesignIpRating(materialIps: Array<string | undefined>): string | null {
  const valid = materialIps.filter((ip): ip is string => ip !== undefined);
  if (valid.length === 0) return null;

  const parsed = valid.map(parseIpRating).filter((p): p is NonNullable<typeof p> => p !== null);
  if (parsed.length === 0) return null;

  // Worst-case (minimum) across all contributing seals/materials
  const dust = Math.min(...parsed.map((p) => p.dust));
  const water = Math.min(...parsed.map((p) => p.water));
  return `IP${dust}${water}`;
}

// ---------------------------------------------------------------------------
// Scoring weights
// Each check contributes a weight; hard violations carry higher weight.
// ---------------------------------------------------------------------------

const WEIGHT = {
  weight: { hard: 0.2, soft: 0.08 },
  dimension: { hard: 0.15, soft: 0.06 },
  ipRating: { hard: 0.2, soft: 0.08 },
  tempRange: { hard: 0.15, soft: 0.06 },
  cost: { soft: 0.08 },
  dropTest: { hard: 0.12, soft: 0.05 },
  certification: { soft: 0.04 }, // per missing cert
} as const;

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createCheckDesignFeasibilityTool(
  definition: ToolDefinition,
): Tool<CheckDesignFeasibilityInput, CheckDesignFeasibilityOutput> {
  return {
    definition,
    inputSchema: CheckDesignFeasibilityInputSchema,

    async execute(input) {
      const { requirements: req, design } = input;

      const violations: FeasibilityViolation[] = [];
      const warnings: string[] = [];
      const recommendations: string[] = [];
      let penaltyScore = 0;
      let totalWeightChecked = 0;

      // ----- 1. Weight -----
      if (req.maxWeightGrams !== undefined) {
        totalWeightChecked += WEIGHT.weight.hard;
        const overPct =
          ((design.estimatedWeightGrams - req.maxWeightGrams) / req.maxWeightGrams) * 100;

        if (overPct > 20) {
          violations.push({
            constraint: "maxWeightGrams",
            required: `≤ ${req.maxWeightGrams} g`,
            actual: `${design.estimatedWeightGrams} g (+${overPct.toFixed(1)}%)`,
            severity: "hard",
          });
          penaltyScore += WEIGHT.weight.hard;
          recommendations.push(
            `Reduce weight by at least ${(design.estimatedWeightGrams - req.maxWeightGrams).toFixed(0)} g. Consider lightweight structural materials (magnesium alloy, carbon fibre composite) or thinner PCB substrate.`,
          );
        } else if (overPct > 5) {
          violations.push({
            constraint: "maxWeightGrams",
            required: `≤ ${req.maxWeightGrams} g`,
            actual: `${design.estimatedWeightGrams} g (+${overPct.toFixed(1)}%)`,
            severity: "soft",
          });
          penaltyScore += WEIGHT.weight.soft;
          warnings.push(
            `Weight is ${overPct.toFixed(1)}% over target. Run estimateProductWeight to identify the heaviest components.`,
          );
        }
      }

      // ----- 2. Dimensions -----
      const dimChecks: Array<[string, number | undefined, number]> = [
        ["maxLengthMm", req.maxLengthMm, design.lengthMm],
        ["maxWidthMm", req.maxWidthMm, design.widthMm],
        ["maxHeightMm", req.maxHeightMm, design.heightMm],
      ];

      for (const [name, limit, actual] of dimChecks) {
        if (limit === undefined) continue;
        totalWeightChecked += WEIGHT.dimension.hard;

        if (actual > limit) {
          const overMm = actual - limit;
          violations.push({
            constraint: name,
            required: `≤ ${limit} mm`,
            actual: `${actual} mm (+${overMm.toFixed(1)} mm)`,
            severity: "hard",
          });
          penaltyScore += WEIGHT.dimension.hard;
          recommendations.push(
            `${name.replace("max", "").replace("Mm", "")} exceeds limit by ${overMm.toFixed(1)} mm. Review PCB stack-up or enclosure wall thickness.`,
          );
        }
      }

      // ----- 3. IP rating -----
      if (req.ipRating !== undefined) {
        totalWeightChecked += WEIGHT.ipRating.hard;
        const designIp = resolveDesignIpRating(design.materials.map((m) => m.ipRatingCapable));

        if (designIp === null) {
          violations.push({
            constraint: "ipRating",
            required: req.ipRating,
            actual: "not specified in any material",
            severity: "hard",
          });
          penaltyScore += WEIGHT.ipRating.hard;
          recommendations.push(
            `Add IP-rated seals or gaskets to materials list. Target: ${req.ipRating}.`,
          );
        } else if (!ipMeetsRequirement(req.ipRating, designIp)) {
          violations.push({
            constraint: "ipRating",
            required: req.ipRating,
            actual: designIp,
            severity: "hard",
          });
          penaltyScore += WEIGHT.ipRating.hard;
          const reqParsed = parseIpRating(req.ipRating);
          const actParsed = parseIpRating(designIp);
          if (reqParsed && actParsed) {
            if (actParsed.dust < reqParsed.dust) {
              recommendations.push(
                `Dust protection is IP${actParsed.dust}X but IP${reqParsed.dust}X required. Add dust filter or improve enclosure seal around openings.`,
              );
            }
            if (actParsed.water < reqParsed.water) {
              recommendations.push(
                `Water protection is IPX${actParsed.water} but IPX${reqParsed.water} required. Upgrade gasket material to EPDM or silicone; review connector seal rating.`,
              );
            }
          }
        }
      }

      // ----- 4. Temperature range -----
      if (req.operatingTempMinC !== undefined || req.operatingTempMaxC !== undefined) {
        totalWeightChecked += WEIGHT.tempRange.hard;
        let tempHardFail = false;

        for (const mat of design.materials) {
          if (req.operatingTempMinC !== undefined && mat.tempMinC !== undefined) {
            if (mat.tempMinC > req.operatingTempMinC) {
              violations.push({
                constraint: "operatingTempMinC",
                required: `≤ ${req.operatingTempMinC} °C`,
                actual: `${mat.name} rated to ${mat.tempMinC} °C`,
                severity: "hard",
              });
              penaltyScore += WEIGHT.tempRange.hard;
              recommendations.push(
                `Replace or supplement '${mat.name}' — rated to ${mat.tempMinC} °C but ${req.operatingTempMinC} °C required. Consider low-temperature ABS or polycarbonate blend.`,
              );
              tempHardFail = true;
            }
          }

          if (req.operatingTempMaxC !== undefined && mat.tempMaxC !== undefined) {
            if (mat.tempMaxC < req.operatingTempMaxC) {
              violations.push({
                constraint: "operatingTempMaxC",
                required: `≥ ${req.operatingTempMaxC} °C`,
                actual: `${mat.name} rated to ${mat.tempMaxC} °C`,
                severity: "hard",
              });
              if (!tempHardFail) penaltyScore += WEIGHT.tempRange.hard;
              recommendations.push(
                `'${mat.name}' max temp (${mat.tempMaxC} °C) is below requirement (${req.operatingTempMaxC} °C). Consider high-heat PPS or PEEK for this component.`,
              );
              tempHardFail = true;
            }
          }
        }

        if (!tempHardFail) {
          // Materials pass but warn if range is very close
          // Margin: how much headroom the material provides beyond the requirement.
          // For min: material goes colder than req → margin = req.min - mat.min (positive = headroom)
          // For max: material goes hotter than req → margin = mat.max - req.max (positive = headroom)
          const tempMarginCheck = design.materials.some(
            (m) =>
              (req.operatingTempMinC !== undefined &&
                m.tempMinC !== undefined &&
                req.operatingTempMinC - m.tempMinC < 10) ||
              (req.operatingTempMaxC !== undefined &&
                m.tempMaxC !== undefined &&
                m.tempMaxC - req.operatingTempMaxC < 10),
          );
          if (tempMarginCheck) {
            warnings.push(
              "Some materials have < 10 °C margin on temperature limits. " +
                "Consider accelerated life testing at temperature extremes.",
            );
          }
        }
      }

      // ----- 5. Cost -----
      if (req.targetUnitCostUsd !== undefined && design.estimatedUnitCostUsd !== undefined) {
        totalWeightChecked += WEIGHT.cost.soft;
        const costRatio = design.estimatedUnitCostUsd / req.targetUnitCostUsd;
        if (costRatio > 1.1) {
          violations.push({
            constraint: "targetUnitCostUsd",
            required: `≤ $${req.targetUnitCostUsd}`,
            actual: `$${design.estimatedUnitCostUsd} (+${((costRatio - 1) * 100).toFixed(1)}%)`,
            severity: "soft",
          });
          penaltyScore += WEIGHT.cost.soft;
          recommendations.push(
            `Unit cost exceeds target by ${((costRatio - 1) * 100).toFixed(1)}%. Run estimateProductionCost at higher volumes to find the break-even point.`,
          );
        }
      }

      // ----- 6. Drop test -----
      if (req.dropTestHeightM !== undefined) {
        totalWeightChecked += WEIGHT.dropTest.hard;
        if (design.dropTestHeightM === undefined) {
          warnings.push(
            `Drop test to ${req.dropTestHeightM} m is required but no design validation data provided. Perform FEA analysis or prototype drop test.`,
          );
          penaltyScore += WEIGHT.dropTest.soft;
        } else if (design.dropTestHeightM < req.dropTestHeightM) {
          violations.push({
            constraint: "dropTestHeightM",
            required: `≥ ${req.dropTestHeightM} m`,
            actual: `${design.dropTestHeightM} m`,
            severity: "hard",
          });
          penaltyScore += WEIGHT.dropTest.hard;
          recommendations.push(
            `Design only validated to ${design.dropTestHeightM} m drop; ${req.dropTestHeightM} m required. Reinforce corners, add internal shock dampening, or thicken enclosure walls.`,
          );
        }
      }

      // ----- 7. Certifications -----
      for (const cert of req.requiredCertifications) {
        totalWeightChecked += WEIGHT.certification.soft;
        const status = design.certificationStatus[cert];
        if (status === undefined || status === "planned") {
          warnings.push(
            `Certification '${cert}' is ${status === "planned" ? "only planned" : "not tracked"}. Start the submission process early — typical lead time is 6–12 weeks.`,
          );
          penaltyScore += WEIGHT.certification.soft;
        } else if (status === "in-progress") {
          warnings.push(
            `Certification '${cert}' is in-progress — verify timeline against launch date.`,
          );
          // in-progress: no score penalty, just a warning
        }
        // "certified" → no action
      }

      // ----- Compute final score -----
      // Score = 1 - (penalty / total weight checked)
      const feasibilityScore =
        totalWeightChecked > 0
          ? Math.max(0, Math.min(1, 1 - penaltyScore / totalWeightChecked))
          : 1;

      const hardViolationCount = violations.filter((v) => v.severity === "hard").length;
      const softViolationCount = violations.filter((v) => v.severity === "soft").length;

      const summary =
        hardViolationCount > 0
          ? `Design has ${hardViolationCount} hard violation(s) and cannot proceed without changes ` +
            `(score: ${feasibilityScore.toFixed(2)}).`
          : softViolationCount > 0
            ? `Design is conditionally feasible with ${softViolationCount} soft issue(s) to resolve ` +
              `(score: ${feasibilityScore.toFixed(2)}).`
            : warnings.length > 0
              ? `Design meets all hard requirements; review ${warnings.length} warning(s) before production ` +
                `(score: ${feasibilityScore.toFixed(2)}).`
              : `Design fully meets all specified requirements (score: ${feasibilityScore.toFixed(2)}).`;

      return {
        feasibilityScore: Math.round(feasibilityScore * 1000) / 1000,
        violations,
        warnings,
        recommendations,
        summary,
      };
    },
  };
}
