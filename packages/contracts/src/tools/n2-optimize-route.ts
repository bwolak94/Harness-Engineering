import { z } from "zod";

export const OptimizeRouteInputSchema = z.object({
  depot: z.object({ lat: z.number(), lng: z.number() }),
  stops: z
    .array(
      z.object({
        id: z.string().min(1),
        lat: z.number(),
        lng: z.number(),
        demand: z.number().nonnegative(),
        windowFrom: z.string().describe("ISO 8601 datetime — earliest arrival"),
        windowTo: z.string().describe("ISO 8601 datetime — latest arrival"),
        serviceMin: z.number().nonnegative().describe("Service time in minutes"),
      }),
    )
    .min(1),
  vehicleCapacity: z.number().positive(),
  maxComputeMs: z.number().int().positive().default(5000),
});

export const OptimizeRouteOutputSchema = z.object({
  sequence: z.array(z.string()).describe("Ordered stop IDs"),
  distanceKm: z.number().nonnegative(),
  durationMin: z.number().nonnegative(),
  violations: z
    .array(
      z.object({
        stopId: z.string(),
        type: z.enum(["time_window", "capacity"]),
        detail: z.string(),
      }),
    )
    .describe("Constraint violations in the returned route"),
  quality: z
    .enum(["optimal", "heuristic", "partial"])
    .describe("Indicates whether time budget allowed a full search"),
});

export type OptimizeRouteInput = z.infer<typeof OptimizeRouteInputSchema>;
export type OptimizeRouteOutput = z.infer<typeof OptimizeRouteOutputSchema>;
