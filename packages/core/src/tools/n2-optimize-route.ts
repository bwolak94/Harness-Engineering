import type { ToolDefinition } from "@harness/contracts";
import {
  type OptimizeRouteInput,
  OptimizeRouteInputSchema,
  type OptimizeRouteOutput,
} from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";

/**
 * N2 — optimizeRoute
 *
 * Vehicle Routing Problem solver: nearest-neighbour initialisation + 2-opt
 * local search, bounded by maxComputeMs. Validates time windows and capacity.
 *
 * This is an *anytime* algorithm — it returns the best route found within the
 * time budget. The `quality` field tells the model whether the result is:
 *   - "optimal"   — all 2-opt improvements exhausted before the deadline
 *   - "heuristic" — 2-opt was cut short by the time budget
 *   - "partial"   — capacity or window violations remain
 *
 * Without `quality`, the model would treat a heuristic result as if it were
 * optimal, which is the canonical failure mode of fast-deadline TSP tools.
 */
export function createOptimizeRouteTool(
  definition: ToolDefinition,
): Tool<OptimizeRouteInput, OptimizeRouteOutput> {
  return {
    definition,
    inputSchema: OptimizeRouteInputSchema,

    async execute(input) {
      const deadline = Date.now() + input.maxComputeMs;

      // Build distance matrix (haversine)
      const nodes = [input.depot, ...input.stops.map((s) => ({ lat: s.lat, lng: s.lng }))];
      const dist = buildDistanceMatrix(nodes);

      // Nearest-neighbour from depot (index 0)
      // stopIndices: indices into input.stops (0-based)
      const stopIndices = Array.from({ length: input.stops.length }, (_, i) => i);
      let route = nearestNeighbour(stopIndices, dist);

      // 2-opt local search (time-bounded)
      let improved = true;
      while (improved && Date.now() < deadline) {
        improved = false;
        for (let i = 0; i < route.length - 1 && Date.now() < deadline; i++) {
          for (let j = i + 2; j < route.length; j++) {
            // 2-opt swap: reverse the sub-route between i+1 and j
            const delta = twoOptGain(route, i, j, dist);
            if (delta > 1e-9) {
              route = twoOptSwap(route, i + 1, j);
              improved = true;
            }
          }
        }
      }

      const timedOut = Date.now() >= deadline;
      const violations = validateRoute(route, input);

      const quality: OptimizeRouteOutput["quality"] =
        violations.length > 0 ? "partial" : timedOut ? "heuristic" : "optimal";

      // Build output: sequence of stop IDs in route order
      const sequence = route.map((i) => {
        const stop = input.stops[i];
        if (!stop) throw new Error(`Invalid route index ${i}`);
        return stop.id;
      });

      const { distanceKm, durationMin } = routeMetrics(route, input, dist);

      return { sequence, distanceKm, durationMin, violations, quality };
    },
  };
}

// ---------------------------------------------------------------------------
// Haversine distance
// ---------------------------------------------------------------------------

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Returns dist[i][j] in km for all nodes (depot=0, stop_k=k+1). */
function buildDistanceMatrix(nodes: ReadonlyArray<{ lat: number; lng: number }>): number[][] {
  const n = nodes.length;
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      const a = nodes[i];
      const b = nodes[j];
      if (!a || !b) return 0;
      return haversineKm(a.lat, a.lng, b.lat, b.lng);
    }),
  );
}

// ---------------------------------------------------------------------------
// Nearest-neighbour heuristic
// ---------------------------------------------------------------------------

/**
 * Build an initial route using nearest-neighbour from the depot (index 0 in
 * the distance matrix). `stopIndices` are 0-based indices into input.stops,
 * mapping to dist-matrix indices as stop_i → dist[i+1].
 */
function nearestNeighbour(stopIndices: number[], dist: number[][]): number[] {
  const remaining = new Set(stopIndices);
  const route: number[] = [];
  let current = -1; // -1 represents depot (dist-matrix index 0)

  while (remaining.size > 0) {
    let bestDist = Number.POSITIVE_INFINITY;
    let bestIdx = -1;

    for (const idx of remaining) {
      // dist-matrix index for stop idx is idx+1
      const d = dist[current === -1 ? 0 : current + 1]?.[idx + 1] ?? Number.POSITIVE_INFINITY;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = idx;
      }
    }

    if (bestIdx === -1) break;
    route.push(bestIdx);
    remaining.delete(bestIdx);
    current = bestIdx;
  }

  return route;
}

// ---------------------------------------------------------------------------
// 2-opt
// ---------------------------------------------------------------------------

/**
 * Gain from reversing the sub-route [i+1..j] in the route.
 * Positive gain = improvement.
 */
function twoOptGain(route: number[], i: number, j: number, dist: number[][]): number {
  const a = route[i] !== undefined ? route[i]! + 1 : 0; // dist-matrix index
  const b = route[i + 1] !== undefined ? route[i + 1]! + 1 : 0;
  const c = route[j] !== undefined ? route[j]! + 1 : 0;
  const d = j + 1 < route.length && route[j + 1] !== undefined ? route[j + 1]! + 1 : 0;

  const before = (dist[a]?.[b] ?? 0) + (dist[c]?.[d] ?? 0);
  const after = (dist[a]?.[c] ?? 0) + (dist[b]?.[d] ?? 0);

  return before - after;
}

function twoOptSwap(route: number[], i: number, j: number): number[] {
  const result = [...route];
  let left = i;
  let right = j;
  while (left < right) {
    const tmp = result[left];
    result[left] = result[right] ?? 0;
    result[right] = tmp ?? 0;
    left++;
    right--;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Validation and metrics
// ---------------------------------------------------------------------------

function validateRoute(
  route: number[],
  input: OptimizeRouteInput,
): OptimizeRouteOutput["violations"] {
  const violations: OptimizeRouteOutput["violations"] = [];
  let load = 0;

  let currentTime = new Date(input.stops[route[0] ?? 0]?.windowFrom ?? new Date().toISOString());
  // Reset to depot departure time: use earliest window start of first stop as reference
  currentTime = new Date(currentTime.getTime());

  for (const stopIdx of route) {
    const stop = input.stops[stopIdx];
    if (!stop) continue;

    load += stop.demand;

    if (load > input.vehicleCapacity) {
      violations.push({
        stopId: stop.id,
        type: "capacity",
        detail: `Cumulative load ${load} exceeds capacity ${input.vehicleCapacity}`,
      });
    }

    const windowFrom = new Date(stop.windowFrom);
    const windowTo = new Date(stop.windowTo);

    if (currentTime > windowTo) {
      violations.push({
        stopId: stop.id,
        type: "time_window",
        detail: `Arrival ${currentTime.toISOString()} is after window close ${stop.windowTo}`,
      });
    }

    // Advance time by service time
    const serviceMs = stop.serviceMin * 60_000;
    currentTime = new Date(Math.max(currentTime.getTime(), windowFrom.getTime()) + serviceMs);
  }

  return violations;
}

function routeMetrics(
  route: number[],
  input: OptimizeRouteInput,
  dist: number[][],
): { distanceKm: number; durationMin: number } {
  const SPEED_KMH = 50;
  let distanceKm = 0;
  let prev = 0; // depot = dist-matrix index 0

  for (const stopIdx of route) {
    const curr = stopIdx + 1;
    distanceKm += dist[prev]?.[curr] ?? 0;
    prev = curr;
  }
  // Return to depot
  distanceKm += dist[prev]?.[0] ?? 0;

  const travelMin = (distanceKm / SPEED_KMH) * 60;
  const serviceMin = route.reduce((sum, i) => sum + (input.stops[i]?.serviceMin ?? 0), 0);
  const durationMin = Math.round(travelMin + serviceMin);

  return { distanceKm: Math.round(distanceKm * 100) / 100, durationMin };
}
