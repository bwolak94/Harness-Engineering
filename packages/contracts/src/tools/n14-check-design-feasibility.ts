import { z } from "zod";

// ---------------------------------------------------------------------------
// IP rating — numeric suffixes only (dust + water)
// ---------------------------------------------------------------------------

const IpRatingSchema = z
  .string()
  .regex(/^IP\d{2}$/, "Must be in the form 'IPxy' e.g. 'IP67'")
  .describe("IEC 60529 IP rating e.g. 'IP54', 'IP67', 'IP68'");

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const DesignRequirementsSchema = z.object({
  maxWeightGrams: z.number().positive().optional().describe("Maximum allowable product weight"),
  maxLengthMm: z.number().positive().optional(),
  maxWidthMm: z.number().positive().optional(),
  maxHeightMm: z.number().positive().optional(),
  ipRating: IpRatingSchema.optional().describe(
    "Required IP rating; the design must meet or exceed this",
  ),
  operatingTempMinC: z.number().optional().describe("Minimum operating temperature in °C"),
  operatingTempMaxC: z.number().optional().describe("Maximum operating temperature in °C"),
  targetUnitCostUsd: z
    .number()
    .positive()
    .optional()
    .describe("Target unit cost at the primary production volume"),
  dropTestHeightM: z
    .number()
    .positive()
    .optional()
    .describe("Required drop-test height in metres per IEC 60068-2-32 / MIL-STD-810"),
  requiredCertifications: z
    .array(z.string().min(1))
    .optional()
    .default([])
    .describe("Required market certifications e.g. ['CE', 'FCC', 'RoHS']"),
});

export const DesignMaterialSchema = z.object({
  name: z.string().min(1).describe("Material or component name e.g. 'ABS plastic', 'Gasket EPDM'"),
  ipRatingCapable: IpRatingSchema.optional().describe(
    "Highest IP rating this material/seal contributes; omit if not relevant",
  ),
  tempMinC: z.number().optional().describe("Material lower temperature limit in °C"),
  tempMaxC: z.number().optional().describe("Material upper temperature limit in °C"),
});

export const CheckDesignFeasibilityInputSchema = z.object({
  requirements: DesignRequirementsSchema,
  design: z.object({
    estimatedWeightGrams: z.number().nonnegative(),
    lengthMm: z.number().nonnegative(),
    widthMm: z.number().nonnegative(),
    heightMm: z.number().nonnegative(),
    materials: z
      .array(DesignMaterialSchema)
      .min(1)
      .max(50)
      .describe("Key materials and seals used in the design"),
    estimatedUnitCostUsd: z
      .number()
      .nonnegative()
      .optional()
      .describe("Current unit-cost estimate at primary production volume"),
    certificationStatus: z
      .record(
        z.string(),
        z.enum(["planned", "in-progress", "certified"]),
      )
      .default({})
      .describe("Certification name → current status"),
    dropTestHeightM: z
      .number()
      .positive()
      .optional()
      .describe("Drop height the design has been validated to (prototype or analysis)"),
  }),
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const FeasibilityViolationSchema = z.object({
  constraint: z.string().describe("Which requirement was checked"),
  required: z.string().describe("What the requirement demands"),
  actual: z.string().describe("What the design delivers"),
  severity: z
    .enum(["hard", "soft"])
    .describe("hard = design cannot proceed as-is; soft = risk but not a blocker"),
});

export const CheckDesignFeasibilityOutputSchema = z.object({
  feasibilityScore: z
    .number()
    .min(0)
    .max(1)
    .describe("0 = impossible, 1 = fully compliant; score < 0.6 indicates a hard blocker"),
  violations: z.array(FeasibilityViolationSchema),
  warnings: z.array(z.string()).describe("Soft risks that should be tracked but are not blockers"),
  recommendations: z
    .array(z.string())
    .describe("Actionable suggestions to resolve violations or reduce warnings"),
  summary: z.string().describe("One-sentence plain-language verdict"),
});

export type DesignRequirements = z.infer<typeof DesignRequirementsSchema>;
export type DesignMaterial = z.infer<typeof DesignMaterialSchema>;
export type CheckDesignFeasibilityInput = z.infer<typeof CheckDesignFeasibilityInputSchema>;
export type FeasibilityViolation = z.infer<typeof FeasibilityViolationSchema>;
export type CheckDesignFeasibilityOutput = z.infer<typeof CheckDesignFeasibilityOutputSchema>;
