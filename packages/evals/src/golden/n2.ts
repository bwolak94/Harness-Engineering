import { FakeModelPort } from "@harness/adapters-memory";
import type { EvalCase } from "../types.js";

/**
 * N2 — optimizeRoute golden cases.
 *
 * TSP with time windows and capacity constraints. Tests:
 *  1. Simple 3-stop route — sequence contains all stop IDs, distance > 0.
 *  2. Capacity-constrained route — violations array present (even if empty).
 */
export const N2_CASES: EvalCase[] = [
  {
    id: "n2-three-stop-route",
    tool: "optimizeRoute",
    description: "3-stop Warsaw delivery route — sequence visits all stops, distanceKm > 0",
    task: {
      id: "eval-n2-three",
      goal: "Find the optimal delivery route for these three stops.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("optimizeRoute", {
        depot: { lat: 52.23, lng: 21.01 },
        stops: [
          {
            id: "stop-A",
            lat: 52.25,
            lng: 21.05,
            demand: 10,
            windowFrom: "2024-06-01T08:00:00Z",
            windowTo: "2024-06-01T12:00:00Z",
            serviceMin: 10,
          },
          {
            id: "stop-B",
            lat: 52.2,
            lng: 20.98,
            demand: 8,
            windowFrom: "2024-06-01T09:00:00Z",
            windowTo: "2024-06-01T14:00:00Z",
            serviceMin: 15,
          },
          {
            id: "stop-C",
            lat: 52.27,
            lng: 20.95,
            demand: 5,
            windowFrom: "2024-06-01T10:00:00Z",
            windowTo: "2024-06-01T16:00:00Z",
            serviceMin: 5,
          },
        ],
        vehicleCapacity: 100,
        maxComputeMs: 1000,
      }),
      FakeModelPort.textResponse("Route optimized."),
    ]),
    outcomeChecks: [
      // sequence must contain 3 stops
      { type: "field_equals", path: "sequence.length", value: 3 },
      { type: "field_gt", path: "distanceKm", value: 0 },
      { type: "field_gt", path: "durationMin", value: 0 },
      // quality must be one of the enum values (truthy string)
      { type: "field_truthy", path: "quality" },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "optimizeRoute" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: true,
  },

  {
    id: "n2-capacity-constrained",
    tool: "optimizeRoute",
    description: "Route with total demand near vehicle capacity — violations array is present",
    task: {
      id: "eval-n2-capacity",
      goal: "Optimize this route with capacity constraints.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("optimizeRoute", {
        depot: { lat: 50.06, lng: 19.94 },
        stops: [
          {
            id: "s1",
            lat: 50.08,
            lng: 19.97,
            demand: 60,
            windowFrom: "2024-06-01T07:00:00Z",
            windowTo: "2024-06-01T18:00:00Z",
            serviceMin: 20,
          },
          {
            id: "s2",
            lat: 50.05,
            lng: 19.91,
            demand: 55,
            windowFrom: "2024-06-01T07:00:00Z",
            windowTo: "2024-06-01T18:00:00Z",
            serviceMin: 20,
          },
        ],
        vehicleCapacity: 100, // total demand = 115 → capacity violation
        maxComputeMs: 500,
      }),
      FakeModelPort.textResponse("Constrained route calculated."),
    ]),
    outcomeChecks: [
      { type: "field_equals", path: "sequence.length", value: 2 },
      { type: "field_gt", path: "distanceKm", value: 0 },
      // violations field must exist (array — could be empty or have entries)
      { type: "field_truthy", path: "violations" },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "optimizeRoute" },
      { type: "status", expected: "completed" },
    ],
    snapshot: false,
  },
];
