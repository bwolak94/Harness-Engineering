import { z } from "zod";

export const TariffZoneSchema = z.object({
  name: z.string().min(1),
  hoursFrom: z.number().int().min(0).max(23),
  hoursTo: z.number().int().min(0).max(24),
  pricePerKwh: z.number().nonnegative(),
});

export const SimulatePVPaybackInputSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  kWp: z.number().positive().describe("Installed peak power in kilowatts"),
  tiltDeg: z.number().min(0).max(90).default(35),
  azimuthDeg: z.number().min(0).max(360).default(180).describe("0=North, 180=South"),
  consumptionProfile: z
    .array(z.number().nonnegative())
    .length(8760)
    .describe("Hourly consumption in kWh for a full year (8760 values)"),
  tariff: z.object({
    zones: z.array(TariffZoneSchema),
    netBilling: z.boolean().default(false).describe("True = net billing; false = net metering"),
    exportRatePerKwh: z.number().nonnegative().default(0),
  }),
  capex: z.number().positive().describe("Total installation cost"),
});

export const SimulatePVPaybackOutputSchema = z.object({
  yearlyKWh: z.number().nonnegative().describe("Estimated annual generation"),
  selfConsumptionPct: z.number().min(0).max(100).describe("% of generation consumed directly"),
  savingsPerYear: z.array(z.number()).describe("Annual savings for each projected year"),
  paybackYears: z.number().positive(),
  monthlyBreakdown: z.array(
    z.object({
      month: z.number().int().min(1).max(12),
      generationKwh: z.number().nonnegative(),
      selfConsumedKwh: z.number().nonnegative(),
      exportedKwh: z.number().nonnegative(),
      savingsEur: z.number(),
    }),
  ),
});

export type SimulatePVPaybackInput = z.infer<typeof SimulatePVPaybackInputSchema>;
export type SimulatePVPaybackOutput = z.infer<typeof SimulatePVPaybackOutputSchema>;
