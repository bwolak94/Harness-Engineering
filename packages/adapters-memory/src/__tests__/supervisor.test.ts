import type { Budget } from "@harness/contracts";
import type { ScreenCandidatesInput } from "@harness/contracts/tools";
import { Supervisor } from "@harness/core";
import type { FanOutResult, SubagentTask, SupervisorPort } from "@harness/core";
import { createScreenCandidatesTool } from "@harness/core/tools";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeTask<T>(id: string, result: T, delayMs = 0): SubagentTask<T> {
  return {
    taskId: id,
    execute: async (_signal: AbortSignal) => {
      if (delayMs > 0) await delay(delayMs);
      return result;
    },
  };
}

function makeFailingTask(id: string, delayMs = 0): SubagentTask<never> {
  return {
    taskId: id,
    execute: async (_signal: AbortSignal) => {
      if (delayMs > 0) await delay(delayMs);
      throw new Error(`${id} failed`);
    },
  };
}

function makeCancellableTask(id: string, checkIntervalMs = 20): SubagentTask<string> {
  return {
    taskId: id,
    execute: async (signal: AbortSignal) => {
      // Poll signal — cooperative cancellation
      for (let i = 0; i < 50; i++) {
        if (signal.aborted) throw new Error("Aborted");
        await delay(checkIntervalMs);
      }
      return `${id} completed`;
    },
  };
}

const TEST_BUDGET: Budget = {
  maxTokens: 1000,
  maxSteps: 10,
  maxWallClockMs: 60_000,
  maxCostUsd: 1.0,
};

// ---------------------------------------------------------------------------
// Supervisor — concurrency and parallelism
// ---------------------------------------------------------------------------

describe("Supervisor — parallelism", () => {
  // DoD: 5 parallel subagents complete in time ≈ slowest, not sum
  it("runs 5 tasks concurrently — total time ≈ slowest, not sum", async () => {
    const supervisor = new Supervisor(5);
    const TASK_MS = 80;

    const tasks = Array.from({ length: 5 }, (_, i) => makeTask(`t${i}`, i, TASK_MS));

    const start = Date.now();
    const result = await supervisor.fanOut(tasks, { concurrencyLimit: 5 });
    const elapsed = Date.now() - start;

    expect(result.partial).toBe(false);
    expect(result.results).toHaveLength(5);
    // Serial would be 5 × 80 = 400ms; parallel should finish in ~80ms
    expect(elapsed).toBeLessThan(TASK_MS * 3); // generous CI slack
    expect(elapsed).toBeGreaterThan(TASK_MS * 0.5); // sanity: at least some time passed
  });

  it("respects concurrency limit — batches of 2 when limit=2", async () => {
    const supervisor = new Supervisor();
    const TASK_MS = 60;
    const LIMIT = 2;

    const tasks = Array.from({ length: 4 }, (_, i) => makeTask(`t${i}`, i, TASK_MS));

    const start = Date.now();
    await supervisor.fanOut(tasks, { concurrencyLimit: LIMIT });
    const elapsed = Date.now() - start;

    // With 4 tasks and limit=2, minimum wall clock is 2 × 60ms = 120ms
    expect(elapsed).toBeGreaterThan(TASK_MS * 1.5);
    // But not serial (4 × 60ms = 240ms)
    expect(elapsed).toBeLessThan(TASK_MS * 3.5);
  });

  it("returns results in task order regardless of completion order", async () => {
    const supervisor = new Supervisor(5);
    // Last task finishes first (no delay), first task is slowest
    const tasks: SubagentTask<number>[] = [
      makeTask("slow", 0, 60),
      makeTask("fast-1", 1, 0),
      makeTask("fast-2", 2, 0),
    ];

    const result = await supervisor.fanOut(tasks, { concurrencyLimit: 3 });

    expect(result.results[0]?.taskId).toBe("slow");
    expect(result.results[1]?.taskId).toBe("fast-1");
    expect(result.results[2]?.taskId).toBe("fast-2");
  });
});

// ---------------------------------------------------------------------------
// Supervisor — graceful degradation
// ---------------------------------------------------------------------------

describe("Supervisor — graceful degradation", () => {
  // DoD: 2 of 5 fail → partial result with missing list
  it("returns partial=true when 2 of 5 tasks fail", async () => {
    const supervisor = new Supervisor(5);
    const tasks: SubagentTask<number>[] = [
      makeTask("t0", 0),
      makeTask("t1", 1),
      makeFailingTask("t2"),
      makeTask("t3", 3),
      makeFailingTask("t4"),
    ];

    const result: FanOutResult<number> = await supervisor.fanOut(tasks, { concurrencyLimit: 5 });

    expect(result.partial).toBe(true);
    const successes = result.results.filter((r) => r.status === "success");
    const failures = result.results.filter((r) => r.status === "failed");
    expect(successes).toHaveLength(3);
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.taskId).sort()).toEqual(["t2", "t4"]);
    // Summary mentions failures
    expect(result.summary).toContain("2 failed");
  });

  it("returns partial=false when all tasks succeed", async () => {
    const supervisor = new Supervisor(5);
    const tasks = Array.from({ length: 3 }, (_, i) => makeTask(`t${i}`, i));

    const result = await supervisor.fanOut(tasks, { concurrencyLimit: 5 });

    expect(result.partial).toBe(false);
    expect(result.results.every((r) => r.status === "success")).toBe(true);
  });

  it("never throws — all failures captured as SubagentFailure", async () => {
    const supervisor = new Supervisor(5);
    const tasks = Array.from({ length: 3 }, (_, i) => makeFailingTask(`t${i}`));

    await expect(supervisor.fanOut(tasks)).resolves.toMatchObject({ partial: true });
  });
});

// ---------------------------------------------------------------------------
// Supervisor — cancellation
// ---------------------------------------------------------------------------

describe("Supervisor — cancellation", () => {
  // DoD: parent cancellation stops all children ≤ 1s
  it("propagates parent abort to all running tasks within 1 s", async () => {
    const supervisor = new Supervisor(5);
    const controller = new AbortController();

    const tasks = Array.from({ length: 5 }, (_, i) => makeCancellableTask(`t${i}`, 30));

    const start = Date.now();
    const fanOutPromise = supervisor.fanOut(tasks, {
      concurrencyLimit: 5,
      signal: controller.signal,
    });

    // Let tasks start, then abort
    await delay(50);
    controller.abort();

    const result = await fanOutPromise;
    const elapsed = Date.now() - start;

    expect(result.partial).toBe(true);
    expect(elapsed).toBeLessThan(1000); // all children stopped within 1s
    // All tasks should have failed with abort reason
    expect(result.results.every((r) => r.status === "failed")).toBe(true);
  });

  it("does not start new tasks once parent signal is already aborted", async () => {
    const supervisor = new Supervisor(1);
    const controller = new AbortController();
    controller.abort(); // pre-aborted

    const started: string[] = [];
    const tasks: SubagentTask<number>[] = [
      {
        taskId: "t0",
        execute: async (_s) => {
          started.push("t0");
          return 0;
        },
      },
      {
        taskId: "t1",
        execute: async (_s) => {
          started.push("t1");
          return 1;
        },
      },
    ];

    await supervisor.fanOut(tasks, { signal: controller.signal, concurrencyLimit: 1 });

    // The pre-aborted signal should prevent most/all tasks from executing
    expect(started).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Supervisor — budget distribution
// ---------------------------------------------------------------------------

describe("Supervisor — budget distribution", () => {
  // DoD: sum of children budgets does not exceed parent budget
  it("distributes parent budget equally and sum does not exceed parent", async () => {
    const supervisor = new Supervisor(5);
    const N = 5;
    const tasks: SubagentTask<void>[] = Array.from({ length: N }, (_, i) => ({
      taskId: `t${i}`,
      execute: async () => undefined,
    }));

    await supervisor.fanOut(tasks, { parentBudget: TEST_BUDGET, concurrencyLimit: N });

    // Each task gets budget/N
    for (const task of tasks) {
      const b = task.allocatedBudget;
      if (!b) throw new Error(`allocatedBudget not set on ${task.taskId}`);
      expect(b.maxTokens).toBe(Math.floor(TEST_BUDGET.maxTokens / N));
      expect(b.maxSteps).toBe(Math.floor(TEST_BUDGET.maxSteps / N));
    }

    // Sum of all allocated tokens ≤ parent
    const totalTokens = tasks.reduce((s, t) => s + (t.allocatedBudget?.maxTokens ?? 0), 0);
    expect(totalTokens).toBeLessThanOrEqual(TEST_BUDGET.maxTokens);
  });
});

// ---------------------------------------------------------------------------
// Supervisor — Composite (nesting)
// ---------------------------------------------------------------------------

describe("Supervisor — Composite (nesting)", () => {
  // DoD: Supervisor works as subagent of another Supervisor
  it("outer supervisor runs inner supervisor as a subagent (2 levels of nesting)", async () => {
    const outer = new Supervisor(3);
    const inner = new Supervisor(3);

    const innerTasks = [
      makeTask("inner-0", "a"),
      makeTask("inner-1", "b"),
      makeTask("inner-2", "c"),
    ];

    // Inner supervisor wrapped as a SubagentTask
    const nestedTask: SubagentTask<FanOutResult<string>> = {
      taskId: "nested",
      execute: (signal) => inner.fanOut(innerTasks, { signal, concurrencyLimit: 3 }),
    };

    const outerTasks: SubagentTask<string | FanOutResult<string>>[] = [
      makeTask("outer-0", "x"),
      nestedTask,
      makeTask("outer-2", "z"),
    ];

    const result = await outer.fanOut(outerTasks, { concurrencyLimit: 3 });

    expect(result.partial).toBe(false);
    expect(result.results).toHaveLength(3);

    // Verify the nested result
    const nestedResult = result.results.find((r) => r.taskId === "nested");
    expect(nestedResult?.status).toBe("success");
    if (nestedResult?.status === "success") {
      const innerResult = nestedResult.value as FanOutResult<string>;
      expect(innerResult.results).toHaveLength(3);
      expect(innerResult.partial).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Supervisor — per-task timeout
// ---------------------------------------------------------------------------

describe("Supervisor — per-task timeout", () => {
  it("fails tasks that exceed taskTimeoutMs", async () => {
    const supervisor = new Supervisor(3);
    const tasks: SubagentTask<string>[] = [
      makeTask("fast", "done", 10),
      {
        taskId: "slow",
        execute: async (signal) => {
          for (let i = 0; i < 20; i++) {
            if (signal.aborted) throw new Error("Aborted");
            await delay(30);
          }
          return "never";
        },
      },
    ];

    const result = await supervisor.fanOut(tasks, {
      concurrencyLimit: 2,
      taskTimeoutMs: 100, // slow task takes ~600ms but gets 100ms
    });

    expect(result.partial).toBe(true);
    const slow = result.results.find((r) => r.taskId === "slow");
    expect(slow?.status).toBe("failed");
    if (slow?.status === "failed") {
      expect(slow.reason).toContain("Timeout");
    }
  });
});

// ---------------------------------------------------------------------------
// N6 screenCandidates — deterministic scoring and context isolation
// ---------------------------------------------------------------------------

describe("N6 screenCandidates — scoring", () => {
  const supervisor = new Supervisor(5);
  const tool = createScreenCandidatesTool(
    {
      name: "screenCandidates",
      description: "test",
      dangerous: false,
      idempotent: true,
      costHint: "expensive",
      inputSchema: {},
      outputSchema: {},
    },
    { supervisor },
  );

  const JOB_SPEC: ScreenCandidatesInput["jobSpec"] = {
    mustHave: ["TypeScript", "Node.js"],
    niceToHave: ["PostgreSQL"],
    weights: { mustHave: 1, niceToHave: 0.5, seniorityMatch: 0.3 },
  };

  const CANDIDATE_A: ScreenCandidatesInput["candidates"][number] = {
    id: "alice",
    skills: ["TypeScript", "Node.js", "PostgreSQL"],
    experience: [{ role: "Backend Engineer", durationMonths: 24, level: "senior" }],
  };

  const CANDIDATE_B: ScreenCandidatesInput["candidates"][number] = {
    id: "bob",
    skills: ["Python"],
    experience: [{ role: "Data Analyst", durationMonths: 12, level: "junior" }],
  };

  it("scores candidates and returns them sorted descending by score", async () => {
    const result = await tool.execute({
      jobSpec: JOB_SPEC,
      candidates: [CANDIDATE_A, CANDIDATE_B],
    });

    expect(result.scored).toHaveLength(2);
    const first = result.scored[0];
    const second = result.scored[1];
    if (!first || !second) throw new Error("Expected 2 scored candidates");
    expect(first.id).toBe("alice"); // higher score first
    expect(second.id).toBe("bob");
    expect(first.score).toBeGreaterThan(second.score);
  });

  it("score is between 0 and 100 for all candidates", async () => {
    const result = await tool.execute({
      jobSpec: JOB_SPEC,
      candidates: [CANDIDATE_A, CANDIDATE_B],
    });
    for (const s of result.scored) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
    }
  });

  it("matchedSkills only includes must-have skills that were found", async () => {
    const result = await tool.execute({ jobSpec: JOB_SPEC, candidates: [CANDIDATE_A] });
    const scored = result.scored[0];
    if (!scored) throw new Error("Expected scored candidate");
    expect(scored.matchedSkills.sort()).toEqual(["Node.js", "TypeScript"]);
  });

  it("gaps lists must-have skills that were missing", async () => {
    const result = await tool.execute({ jobSpec: JOB_SPEC, candidates: [CANDIDATE_B] });
    const scored = result.scored[0];
    if (!scored) throw new Error("Expected scored candidate");
    expect(scored.gaps.sort()).toEqual(["Node.js", "TypeScript"]);
  });

  // DoD: score of candidate X is identical regardless of batch composition
  it("score is identical regardless of batch composition (context isolation)", async () => {
    const aloneResult = await tool.execute({ jobSpec: JOB_SPEC, candidates: [CANDIDATE_A] });
    const batchResult = await tool.execute({
      jobSpec: JOB_SPEC,
      candidates: [CANDIDATE_A, CANDIDATE_B],
    });

    const aliceAlone = aloneResult.scored.find((s) => s.id === "alice");
    const aliceInBatch = batchResult.scored.find((s) => s.id === "alice");

    expect(aliceAlone?.score).toBe(aliceInBatch?.score);
    expect(aliceAlone?.matchedSkills).toEqual(aliceInBatch?.matchedSkills);
    expect(aliceAlone?.gaps).toEqual(aliceInBatch?.gaps);
  });

  it("rubricBreakdown contains mustHave, niceToHave, and seniority dimensions", async () => {
    const result = await tool.execute({ jobSpec: JOB_SPEC, candidates: [CANDIDATE_A] });
    const scored = result.scored[0];
    if (!scored) throw new Error("Expected scored candidate");
    const breakdown = scored.rubricBreakdown;
    expect(breakdown).toHaveProperty("mustHave");
    expect(breakdown).toHaveProperty("niceToHave");
    expect(breakdown).toHaveProperty("seniority");
  });

  it("partial fan-out: failed candidate scoring is excluded from ranking", async () => {
    // Use a supervisor whose task for one candidate will fail
    let callCount = 0;
    const failingOnSecondSupervisor: SupervisorPort = {
      fanOut: async (tasks, opts) => {
        // Simulate first task succeeding, second failing
        callCount++;
        return supervisor.fanOut(
          tasks.map((t, i) =>
            i === 1
              ? {
                  ...t,
                  execute: async () => {
                    throw new Error("scoring error");
                  },
                }
              : t,
          ),
          opts,
        );
      },
    };

    const partialTool = createScreenCandidatesTool(
      {
        name: "screenCandidates",
        description: "test",
        dangerous: false,
        idempotent: true,
        costHint: "expensive",
        inputSchema: {},
        outputSchema: {},
      },
      { supervisor: failingOnSecondSupervisor },
    );

    const result = await partialTool.execute({
      jobSpec: JOB_SPEC,
      candidates: [CANDIDATE_A, CANDIDATE_B],
    });

    // Only alice scored; bob's task failed
    expect(result.scored).toHaveLength(1);
    const scored = result.scored[0];
    if (!scored) throw new Error("Expected scored candidate");
    expect(scored.id).toBe("alice");
    expect(result.rankingRationale).toContain("1 of 2");
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reducer — supervisor.synthesized advances seq and sets completed_partial
// ---------------------------------------------------------------------------

describe("reducer — supervisor.synthesized event", () => {
  it("sets status to completed_partial when partial=true", async () => {
    const { reduce } = await import("@harness/core/domain");
    const { initialWorkflowState } = await import("@harness/core/domain");

    const state = { ...initialWorkflowState("wf-test"), seq: 2, status: "running" as const };

    const event = {
      id: "ev-1",
      workflowId: "wf-test",
      seq: 3,
      at: new Date().toISOString(),
      type: "supervisor.synthesized" as const,
      payload: {
        parentWorkflowId: "wf-test",
        totalTasks: 5,
        successCount: 3,
        failedCount: 2,
        partial: true,
        summary: "3 of 5 completed",
      },
    };

    const next = reduce(state, event);
    expect(next.seq).toBe(3);
    expect(next.status).toBe("completed_partial");
  });

  it("leaves status unchanged when partial=false", async () => {
    const { reduce } = await import("@harness/core/domain");
    const { initialWorkflowState } = await import("@harness/core/domain");

    const state = { ...initialWorkflowState("wf-test"), seq: 2, status: "running" as const };

    const event = {
      id: "ev-1",
      workflowId: "wf-test",
      seq: 3,
      at: new Date().toISOString(),
      type: "supervisor.synthesized" as const,
      payload: {
        parentWorkflowId: "wf-test",
        totalTasks: 5,
        successCount: 5,
        failedCount: 0,
        partial: false,
        summary: "5 of 5 completed",
      },
    };

    const next = reduce(state, event);
    expect(next.seq).toBe(3);
    expect(next.status).toBe("running"); // unchanged
  });
});
