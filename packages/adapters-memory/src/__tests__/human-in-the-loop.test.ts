import type { ApprovalResponse } from "@harness/contracts";
import { getToolDefinition } from "@harness/contracts/tools";
import {
  ApprovalRequestNotFoundError,
  HarnessRuntime,
  WorkflowNotSuspendedError,
  aboveClaimAmount,
  asExecutor,
  isDangerous,
} from "@harness/core";
import { createApplyRepricingTool, createDefaultToolExecutors } from "@harness/core/tools";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeModelPort } from "../fake-model-port.js";
import { FixedClock } from "../fixed-clock.js";
import { InMemoryApprovalStore } from "../in-memory-approval-store.js";
import { InMemoryEventLog } from "../in-memory-event-log.js";
import { InMemoryIdempotencyStore } from "../in-memory-idempotency-store.js";
import { InMemoryOutbox } from "../in-memory-outbox.js";
import { InMemoryStateStore } from "../in-memory-state-store.js";
import { InMemoryToolRegistry } from "../in-memory-tool-registry.js";
import { SeededIdPort } from "../seeded-id-port.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Catalogue used by N11 in tests — contains all SKUs referenced by test tool calls.
 * Pre-populated so applyRepricing can record previousPrice without needing live data.
 */
const TEST_CATALOGUE = new Map<string, number>([
  ["A1", 9.99],
  ["B1", 19.99],
  ["C1", 29.99],
  ["D1", 39.99],
  ["E1", 49.99],
  ["F1", 59.99],
  ["X1", 4.99],
]);

function buildRuntime({
  modelPort,
  approvalStore,
  approvalPolicy = isDangerous(),
  approvalTimeoutMs = 60_000,
  idPort,
  clock,
  eventLog = new InMemoryEventLog(),
  stateStore = new InMemoryStateStore(),
}: {
  modelPort: FakeModelPort;
  approvalStore: InMemoryApprovalStore;
  approvalPolicy?: ReturnType<typeof isDangerous> | ReturnType<typeof aboveClaimAmount>;
  approvalTimeoutMs?: number;
  idPort: SeededIdPort;
  clock: FixedClock;
  eventLog?: InMemoryEventLog;
  stateStore?: InMemoryStateStore;
}) {
  const toolRegistry = new InMemoryToolRegistry();

  for (const executor of createDefaultToolExecutors()) {
    toolRegistry.register(executor);
  }

  // N11 applyRepricing is not in createDefaultToolExecutors() (needs I/O deps),
  // so we wire it up here with in-memory adapters for testing.
  const applyRepricingDef = getToolDefinition("applyRepricing");
  if (!applyRepricingDef) throw new Error("applyRepricing not found in TOOL_REGISTRY");
  toolRegistry.register(
    asExecutor(
      createApplyRepricingTool(applyRepricingDef, {
        outbox: new InMemoryOutbox(),
        idempotencyStore: new InMemoryIdempotencyStore(),
        catalogue: TEST_CATALOGUE,
        clock: { nowIso: () => clock.nowIso(), newId: () => idPort.newId() },
      }),
    ),
  );

  const runtime = new HarnessRuntime({
    model: modelPort,
    eventLog,
    stateStore,
    toolRegistry,
    clock,
    idPort,
    middleware: [],
    approvalStore,
    approvalPolicy,
    approvalTimeoutMs,
  });

  return { runtime, eventLog, stateStore, toolRegistry };
}

function makeTask(id: string) {
  return {
    id,
    goal: "apply repricing to catalog",
    budget: {
      maxTokens: 100_000,
      maxSteps: 20,
      maxWallClockMs: 300_000,
      maxCostUsd: 10,
    },
  };
}

// ---------------------------------------------------------------------------
// T12 — Human-in-the-loop tests
// ---------------------------------------------------------------------------

describe("T12 — Human-in-the-loop", () => {
  let clock: FixedClock;
  let idPort: SeededIdPort;

  beforeEach(() => {
    clock = new FixedClock(1_000_000);
    idPort = new SeededIdPort();
  });

  // -------------------------------------------------------------------------
  // Suspension
  // -------------------------------------------------------------------------

  it("dangerous tool → workflow suspends with no process resources held", async () => {
    const approvalStore = new InMemoryApprovalStore();
    const model = FakeModelPort.singleToolCall("applyRepricing", {
      changes: [{ sku: "A1", newPrice: 10 }],
      idempotencyKey: "k1",
      effectiveAt: "2025-01-01T00:00:00Z",
    });

    const { runtime } = buildRuntime({ modelPort: model, approvalStore, idPort, clock });
    const state = await runtime.run(makeTask("wf-01"));

    expect(state.status).toBe("suspended");
    expect(approvalStore.size).toBe(1);

    // Verify the stored request has the correct context
    const requests = await approvalStore.getByWorkflow("wf-01");
    expect(requests).toHaveLength(1);
    const req = requests[0];
    if (!req) throw new Error("request not found");
    expect(req.toolName).toBe("applyRepricing");
    expect(req.status).toBe("pending");
    expect(req.callId).toMatch(/.+/);
  });

  it("suspension emits approval.requested + workflow.suspended events in order", async () => {
    const approvalStore = new InMemoryApprovalStore();
    const model = FakeModelPort.singleToolCall("applyRepricing", {
      changes: [{ sku: "X1", newPrice: 5 }],
      idempotencyKey: "k2",
      effectiveAt: "2025-01-01T00:00:00Z",
    });

    const { runtime, eventLog } = buildRuntime({
      modelPort: model,
      approvalStore,
      idPort,
      clock,
    });
    await runtime.run(makeTask("wf-02"));

    const events = await eventLog.read("wf-02");
    const types = events.map((e) => e.type);

    expect(types).toContain("approval.requested");
    expect(types).toContain("workflow.suspended");

    const approvalReqIdx = types.indexOf("approval.requested");
    const suspendedIdx = types.indexOf("workflow.suspended");
    expect(approvalReqIdx).toBeLessThan(suspendedIdx);

    // tool.failed MUST NOT be in the log (it was skipped by withEventEmission)
    expect(types).not.toContain("tool.failed");
    // tool.called MUST be in the log (the "continuation as data")
    expect(types).toContain("tool.called");
  });

  // -------------------------------------------------------------------------
  // Rejection
  // -------------------------------------------------------------------------

  it("rejected → workflow.failed with decidedBy recorded", async () => {
    const approvalStore = new InMemoryApprovalStore();
    const model = FakeModelPort.singleToolCall("applyRepricing", {
      changes: [{ sku: "B1", newPrice: 20 }],
      idempotencyKey: "k3",
      effectiveAt: "2025-01-01T00:00:00Z",
    });

    const { runtime, eventLog } = buildRuntime({
      modelPort: model,
      approvalStore,
      idPort,
      clock,
    });
    await runtime.run(makeTask("wf-03"));

    const rejectionResponse: ApprovalResponse = {
      requestId: (await approvalStore.getByWorkflow("wf-03"))[0]?.requestId ?? "x",
      decision: "rejected",
      decidedBy: "auditor@example.com",
      decidedAt: new Date(clock.now()).toISOString(),
      comment: "price increase exceeds policy",
    };

    const stateAfter = await runtime.resumeWithDecision("wf-03", rejectionResponse);
    expect(stateAfter.status).toBe("failed");
    expect(stateAfter.error).toContain("auditor@example.com");

    const events = await eventLog.read("wf-03");
    const types = events.map((e) => e.type);
    expect(types).toContain("approval.rejected");
    expect(types).toContain("workflow.failed");
  });

  // -------------------------------------------------------------------------
  // Approval and continuation
  // -------------------------------------------------------------------------

  it("approved → tool executes and workflow continues to completion", async () => {
    const approvalStore = new InMemoryApprovalStore();

    // Turn 1: model requests applyRepricing (gets suspended)
    // After approval: model should see the result and then complete
    const model = FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("applyRepricing", {
        changes: [{ sku: "C1", newPrice: 30 }],
        idempotencyKey: "k4",
        effectiveAt: "2025-01-01T00:00:00Z",
      }),
      FakeModelPort.textResponse("Repricing applied successfully"),
    ]);

    const { runtime, stateStore } = buildRuntime({
      modelPort: model,
      approvalStore,
      idPort,
      clock,
    });
    await runtime.run(makeTask("wf-04"));

    // At this point the workflow is suspended
    const suspendedState = (await stateStore.load("wf-04"))?.state;
    expect(suspendedState?.status).toBe("suspended");

    const requests = await approvalStore.getByWorkflow("wf-04");
    const req = requests[0];
    if (!req) throw new Error("no pending request");

    const approvalResp: ApprovalResponse = {
      requestId: req.requestId,
      decision: "approved",
      decidedBy: "manager@example.com",
      decidedAt: new Date(clock.now()).toISOString(),
    };

    const finalState = await runtime.resumeWithDecision("wf-04", approvalResp);
    expect(finalState.status).toBe("completed");
  });

  it("approved → event log contains approval.granted + workflow.resumed + tool.succeeded", async () => {
    const approvalStore = new InMemoryApprovalStore();
    const model = FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("applyRepricing", {
        changes: [{ sku: "D1", newPrice: 40 }],
        idempotencyKey: "k5",
        effectiveAt: "2025-01-01T00:00:00Z",
      }),
      FakeModelPort.textResponse("Done"),
    ]);

    const { runtime, eventLog } = buildRuntime({
      modelPort: model,
      approvalStore,
      idPort,
      clock,
    });
    await runtime.run(makeTask("wf-05"));

    const req = (await approvalStore.getByWorkflow("wf-05"))[0];
    if (!req) throw new Error("no request");

    await runtime.resumeWithDecision("wf-05", {
      requestId: req.requestId,
      decision: "approved",
      decidedBy: "ops@example.com",
      decidedAt: new Date(clock.now()).toISOString(),
    });

    const events = await eventLog.read("wf-05");
    const types = events.map((e) => e.type);
    expect(types).toContain("approval.granted");
    expect(types).toContain("workflow.resumed");
    expect(types).toContain("tool.succeeded");
    expect(types).toContain("workflow.completed");

    // Order: approval.granted before workflow.resumed before tool.succeeded
    const grantIdx = types.indexOf("approval.granted");
    const resumeIdx = types.indexOf("workflow.resumed");
    const succIdx = types.indexOf("tool.succeeded");
    expect(grantIdx).toBeLessThan(resumeIdx);
    expect(resumeIdx).toBeLessThan(succIdx);
  });

  // -------------------------------------------------------------------------
  // Simulated SIGKILL: suspend → process restart → approve → continue
  // -------------------------------------------------------------------------

  it("SIGKILL simulation: suspend → new runtime → approve → workflow completes", async () => {
    const approvalStore = new InMemoryApprovalStore();
    const sharedEventLog = new InMemoryEventLog();
    const sharedStateStore = new InMemoryStateStore();

    // Turn 1: model requests dangerous tool → gets suspended
    const model1 = FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("applyRepricing", {
        changes: [{ sku: "E1", newPrice: 50 }],
        idempotencyKey: "k6",
        effectiveAt: "2025-01-01T00:00:00Z",
      }),
      FakeModelPort.textResponse("Repricing complete"),
    ]);

    const { runtime: rt1 } = buildRuntime({
      modelPort: model1,
      approvalStore,
      idPort,
      clock,
      eventLog: sharedEventLog,
      stateStore: sharedStateStore,
    });
    await rt1.run(makeTask("wf-06"));

    // Simulate SIGKILL: create a brand-new runtime but with the SAME persistent stores.
    const model2 = FakeModelPort.sequence([FakeModelPort.textResponse("Repricing complete")]);

    const { runtime: rt2 } = buildRuntime({
      modelPort: model2,
      approvalStore,
      idPort,
      clock,
      eventLog: sharedEventLog, // same persistent log
      stateStore: sharedStateStore, // same persistent state
    });

    const req = (await approvalStore.getByWorkflow("wf-06"))[0];
    if (!req) throw new Error("no pending request after SIGKILL");

    const finalState = await rt2.resumeWithDecision("wf-06", {
      requestId: req.requestId,
      decision: "approved",
      decidedBy: "manager@example.com",
      decidedAt: new Date(clock.now()).toISOString(),
    });

    expect(finalState.status).toBe("completed");
  });

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------

  it("resumeWithDecision on non-suspended workflow throws WorkflowNotSuspendedError", async () => {
    const approvalStore = new InMemoryApprovalStore();
    const model = FakeModelPort.textOnly("Done");
    const { runtime } = buildRuntime({ modelPort: model, approvalStore, idPort, clock });
    await runtime.run(makeTask("wf-07"));

    await expect(
      runtime.resumeWithDecision("wf-07", {
        requestId: "r1",
        decision: "approved",
        decidedBy: "x@y.com",
        decidedAt: new Date(clock.now()).toISOString(),
      }),
    ).rejects.toThrow(WorkflowNotSuspendedError);
  });

  it("resumeWithDecision with no pending request throws ApprovalRequestNotFoundError", async () => {
    const approvalStore = new InMemoryApprovalStore();
    const model = FakeModelPort.singleToolCall("applyRepricing", {
      changes: [],
      idempotencyKey: "k7",
      effectiveAt: "2025-01-01T00:00:00Z",
    });
    const { runtime } = buildRuntime({ modelPort: model, approvalStore, idPort, clock });
    await runtime.run(makeTask("wf-08"));

    // Manually mark the request as already decided to simulate double-submit
    const req = (await approvalStore.getByWorkflow("wf-08"))[0];
    if (!req) throw new Error("no request");
    await approvalStore.decide(req.requestId, {
      requestId: req.requestId,
      decision: "approved",
      decidedBy: "x@y.com",
      decidedAt: new Date(clock.now()).toISOString(),
    });

    // Now there are no PENDING requests left
    await expect(
      runtime.resumeWithDecision("wf-08", {
        requestId: req.requestId,
        decision: "approved",
        decidedBy: "x@y.com",
        decidedAt: new Date(clock.now()).toISOString(),
      }),
    ).rejects.toThrow(ApprovalRequestNotFoundError);
  });

  // -------------------------------------------------------------------------
  // Amount-based approval gate (N5 assessClaim)
  // -------------------------------------------------------------------------

  it("aboveClaimAmount policy: small claim executes without approval", async () => {
    const approvalStore = new InMemoryApprovalStore();
    const smallClaimArgs = {
      policy: {
        sumInsured: 50_000,
        deductible: 500,
        deductibleType: "reductive",
        limits: [],
        depreciationTable: [],
      },
      claim: { type: "theft", estimatedLoss: 1_000, itemAge: 1 },
      evidence: ["doc-001"],
    };

    const model = FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("assessClaim", smallClaimArgs),
      FakeModelPort.textResponse("Claim assessed"),
    ]);

    const { runtime } = buildRuntime({
      modelPort: model,
      approvalStore,
      approvalPolicy: aboveClaimAmount(5_000), // threshold: 5000
      idPort,
      clock,
    });
    const state = await runtime.run(makeTask("wf-09"));

    // Small claim (1000 < 5000): should complete without suspension
    expect(state.status).toBe("completed");
    expect(approvalStore.size).toBe(0); // no approval request created
  });

  it("aboveClaimAmount policy: large claim triggers suspension", async () => {
    const approvalStore = new InMemoryApprovalStore();
    const largeClaimArgs = {
      policy: {
        sumInsured: 100_000,
        deductible: 1_000,
        deductibleType: "reductive",
        limits: [],
        depreciationTable: [],
      },
      claim: { type: "fire", estimatedLoss: 50_000, itemAge: 2 },
      evidence: ["doc-002"],
    };

    const model = FakeModelPort.singleToolCall("assessClaim", largeClaimArgs);
    const { runtime } = buildRuntime({
      modelPort: model,
      approvalStore,
      approvalPolicy: aboveClaimAmount(5_000), // threshold: 5000
      idPort,
      clock,
    });
    const state = await runtime.run(makeTask("wf-10"));

    // Large claim (50000 > 5000): should suspend
    expect(state.status).toBe("suspended");
    expect(approvalStore.size).toBe(1);
    const req = (await approvalStore.getByWorkflow("wf-10"))[0];
    if (!req) throw new Error("no request");
    expect(req.toolName).toBe("assessClaim");
  });

  // -------------------------------------------------------------------------
  // DoD: every dangerous: true tool requires approval (parametrised)
  // -------------------------------------------------------------------------

  // applyRepricing (N11) is the only dangerous: true tool in TOOL_REGISTRY.
  // It is not in createDefaultToolExecutors() (needs I/O deps), but buildRuntime() registers it.
  it.each(["applyRepricing"])(
    "dangerous tool %s → requires approval (isDangerous policy)",
    async (toolName) => {
      const approvalStore = new InMemoryApprovalStore();

      // Build minimal args for this tool — we just need any call to trigger policy
      const model = FakeModelPort.singleToolCall(toolName, {});
      const { runtime } = buildRuntime({
        modelPort: model,
        approvalStore,
        approvalPolicy: isDangerous(),
        idPort,
        clock,
      });
      const state = await runtime.run(makeTask(`wf-dangerous-${toolName}`));

      // The tool is dangerous — workflow must be suspended, not failed with TOOL_NOT_FOUND etc.
      expect(state.status).toBe("suspended");
      expect(approvalStore.size).toBeGreaterThan(0);
    },
  );

  // -------------------------------------------------------------------------
  // Fake clock: approval at fake 24h works same as 24s
  // -------------------------------------------------------------------------

  it("fake-clock approval after 24h is identical to immediate approval", async () => {
    const approvalStore = new InMemoryApprovalStore();
    const model = FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("applyRepricing", {
        changes: [{ sku: "F1", newPrice: 60 }],
        idempotencyKey: "k8",
        effectiveAt: "2025-01-01T00:00:00Z",
      }),
      FakeModelPort.textResponse("Done"),
    ]);

    const { runtime } = buildRuntime({
      modelPort: model,
      approvalStore,
      approvalTimeoutMs: 24 * 60 * 60 * 1000, // 24h
      idPort,
      clock,
    });
    await runtime.run(makeTask("wf-11"));

    // Advance fake clock by 24h
    clock.advance(24 * 60 * 60 * 1000);

    const req = (await approvalStore.getByWorkflow("wf-11"))[0];
    if (!req) throw new Error("no request");

    const stateAfter = await runtime.resumeWithDecision("wf-11", {
      requestId: req.requestId,
      decision: "approved",
      decidedBy: "late-approver@example.com",
      decidedAt: new Date(clock.now()).toISOString(),
    });

    expect(stateAfter.status).toBe("completed");
  });
});
