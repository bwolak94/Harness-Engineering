import type { OptimizeRouteInput } from "@harness/contracts/tools";
import { describe, expect, it } from "vitest";
import { createOptimizeRouteTool } from "../n2-optimize-route.js";

const DEF = {
  name: "optimizeRoute",
  description: "test",
  dangerous: false,
  idempotent: true,
  costHint: "expensive" as const,
  inputSchema: {},
  outputSchema: {},
};

const tool = createOptimizeRouteTool(DEF);

const DEPOT = { lat: 52.23, lng: 21.01 }; // Warsaw

const BASE_INPUT: OptimizeRouteInput = {
  depot: DEPOT,
  stops: [
    {
      id: "A",
      lat: 52.25,
      lng: 21.02,
      demand: 10,
      windowFrom: "2026-01-01T08:00:00Z",
      windowTo: "2026-01-01T18:00:00Z",
      serviceMin: 15,
    },
    {
      id: "B",
      lat: 52.22,
      lng: 21.04,
      demand: 5,
      windowFrom: "2026-01-01T08:00:00Z",
      windowTo: "2026-01-01T18:00:00Z",
      serviceMin: 10,
    },
    {
      id: "C",
      lat: 52.2,
      lng: 20.98,
      demand: 8,
      windowFrom: "2026-01-01T08:00:00Z",
      windowTo: "2026-01-01T18:00:00Z",
      serviceMin: 20,
    },
  ],
  vehicleCapacity: 100,
  maxComputeMs: 2000,
};

describe("optimizeRoute", () => {
  it("returns all required output fields", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(Array.isArray(out.sequence)).toBe(true);
    expect(typeof out.distanceKm).toBe("number");
    expect(typeof out.durationMin).toBe("number");
    expect(Array.isArray(out.violations)).toBe(true);
    expect(["optimal", "heuristic", "partial"]).toContain(out.quality);
  });

  it("sequence contains all stop IDs exactly once", async () => {
    const out = await tool.execute(BASE_INPUT);
    const ids = BASE_INPUT.stops.map((s) => s.id);
    expect(out.sequence.sort()).toEqual(ids.sort());
  });

  it("distanceKm is positive", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(out.distanceKm).toBeGreaterThan(0);
  });

  it("durationMin includes service time", async () => {
    const out = await tool.execute(BASE_INPUT);
    // Total service = 15+10+20 = 45 min; total must be > 45
    expect(out.durationMin).toBeGreaterThan(45);
  });

  it("no violations when capacity is sufficient and windows are wide", async () => {
    const out = await tool.execute(BASE_INPUT);
    const capacityViolations = out.violations.filter((v) => v.type === "capacity");
    expect(capacityViolations).toHaveLength(0);
  });

  it("capacity violation when load exceeds vehicleCapacity", async () => {
    const input: OptimizeRouteInput = {
      ...BASE_INPUT,
      vehicleCapacity: 5, // total demand is 23, well above 5
    };
    const out = await tool.execute(input);
    const capacityViolations = out.violations.filter((v) => v.type === "capacity");
    expect(capacityViolations.length).toBeGreaterThan(0);
    expect(out.quality).toBe("partial");
  });

  it("single stop route is valid", async () => {
    const input: OptimizeRouteInput = {
      ...BASE_INPUT,
      stops: [BASE_INPUT.stops[0]!],
    };
    const out = await tool.execute(input);
    expect(out.sequence).toHaveLength(1);
    expect(out.sequence[0]).toBe("A");
  });

  it("quality is heuristic or optimal (not partial) for feasible inputs", async () => {
    const out = await tool.execute(BASE_INPUT);
    expect(["optimal", "heuristic"]).toContain(out.quality);
  });

  it("respects maxComputeMs anytime contract — always returns within budget + slack", async () => {
    const start = Date.now();
    const input: OptimizeRouteInput = {
      ...BASE_INPUT,
      stops: Array.from({ length: 15 }, (_, i) => ({
        id: `stop-${i}`,
        lat: 52.0 + i * 0.01,
        lng: 21.0 + i * 0.005,
        demand: 1,
        windowFrom: "2026-01-01T06:00:00Z",
        windowTo: "2026-01-01T22:00:00Z",
        serviceMin: 5,
      })),
      maxComputeMs: 300,
    };
    const out = await tool.execute(input);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1500); // generous slack for CI
    expect(["optimal", "heuristic", "partial"]).toContain(out.quality);
    expect(out.sequence).toHaveLength(15);
  });
});
