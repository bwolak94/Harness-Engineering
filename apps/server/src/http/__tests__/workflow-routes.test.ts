import type { HarnessEvent } from "@harness/contracts";
import type { WorkflowState } from "@harness/core";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { HarnessService } from "../../service/harness-service.js";
import { registerWorkflowRoutes } from "../workflow-routes.js";

// ---------------------------------------------------------------------------
// Minimal HarnessService stub
// ---------------------------------------------------------------------------

function makeService(overrides?: Partial<HarnessService>): HarnessService {
  const defaults: HarnessService = {
    start: vi.fn().mockReturnValue({ workflowId: "wf-test-1" }),
    getState: vi.fn().mockResolvedValue(undefined),
    getEvents: vi.fn().mockResolvedValue([]),
  } as unknown as HarnessService;
  return { ...defaults, ...overrides } as HarnessService;
}

function buildApp(service: HarnessService) {
  const fastify = Fastify();
  registerWorkflowRoutes(fastify, service);
  return fastify;
}

// ---------------------------------------------------------------------------
// POST /workflows
// ---------------------------------------------------------------------------

describe("POST /workflows", () => {
  it("returns 202 with workflowId on valid body", async () => {
    const service = makeService();
    const app = buildApp(service);

    const res = await app.inject({
      method: "POST",
      url: "/workflows",
      body: { goal: "Analyse the investment" },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json<{ workflowId: string }>();
    expect(body.workflowId).toBe("wf-test-1");
    expect(service.start).toHaveBeenCalledWith(
      expect.objectContaining({ goal: "Analyse the investment" }),
    );
  });

  it("returns 400 when goal is missing", async () => {
    const app = buildApp(makeService());

    const res = await app.inject({
      method: "POST",
      url: "/workflows",
      body: {},
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ type: string; status: number }>();
    expect(body.status).toBe(400);
  });

  it("passes budget to service when provided", async () => {
    const service = makeService();
    const app = buildApp(service);

    await app.inject({
      method: "POST",
      url: "/workflows",
      body: { goal: "test", budget: { maxSteps: 5 } },
    });

    expect(service.start).toHaveBeenCalledWith(
      expect.objectContaining({ budget: { maxSteps: 5 } }),
    );
  });
});

// ---------------------------------------------------------------------------
// GET /workflows/:id
// ---------------------------------------------------------------------------

describe("GET /workflows/:id", () => {
  it("returns 200 with state when workflow exists", async () => {
    const state = { id: "wf-1", status: "completed" } as unknown as WorkflowState;
    const service = makeService({
      getState: vi.fn().mockResolvedValue(state),
    } as unknown as HarnessService);
    const app = buildApp(service);

    const res = await app.inject({ method: "GET", url: "/workflows/wf-1" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "completed" });
  });

  it("returns 404 with problem+json when workflow not found", async () => {
    const app = buildApp(makeService());

    const res = await app.inject({ method: "GET", url: "/workflows/missing" });

    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    const body = res.json<{ status: number; title: string }>();
    expect(body.status).toBe(404);
    expect(body.title).toBe("Not Found");
  });
});

// ---------------------------------------------------------------------------
// GET /workflows/:id/events
// ---------------------------------------------------------------------------

describe("GET /workflows/:id/events", () => {
  it("returns events array", async () => {
    const events: HarnessEvent[] = [
      {
        id: "e1",
        workflowId: "wf-1",
        seq: 0,
        at: new Date(0).toISOString(),
        type: "workflow.started",
        payload: {
          task: {
            id: "wf-1",
            goal: "test",
            budget: { maxTokens: 1, maxSteps: 1, maxWallClockMs: 1, maxCostUsd: 1 },
          },
        },
      },
    ];
    const service = makeService({
      getEvents: vi.fn().mockResolvedValue(events),
    } as unknown as HarnessService);
    const app = buildApp(service);

    const res = await app.inject({ method: "GET", url: "/workflows/wf-1/events" });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ events: HarnessEvent[] }>();
    expect(body.events).toHaveLength(1);
  });

  it("passes fromSeq query param to service", async () => {
    const service = makeService();
    const app = buildApp(service);

    await app.inject({ method: "GET", url: "/workflows/wf-1/events?fromSeq=5" });

    expect(service.getEvents).toHaveBeenCalledWith("wf-1", 5);
  });

  it("defaults fromSeq to 0 when not provided", async () => {
    const service = makeService();
    const app = buildApp(service);

    await app.inject({ method: "GET", url: "/workflows/wf-1/events" });

    expect(service.getEvents).toHaveBeenCalledWith("wf-1", 0);
  });

  it("returns 400 for invalid fromSeq", async () => {
    const app = buildApp(makeService());

    const res = await app.inject({ method: "GET", url: "/workflows/wf-1/events?fromSeq=abc" });

    expect(res.statusCode).toBe(400);
  });
});
