import { describe, expect, it } from "vitest";
import { err, ok } from "../../domain/result.js";
import type {
  ToolCallError,
  ToolExecutor,
  ToolRegistryPort,
} from "../../ports/tool-registry.port.js";
import {
  type ComposedToolChainStep,
  type ComposedToolSpec,
  createComposedToolExecutor,
  validateComposedToolSpec,
} from "../composed-tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecutor(name: string, fn: (args: unknown) => unknown): ToolExecutor {
  return {
    definition: {
      name,
      description: `Mock tool: ${name}`,
      dangerous: false,
      idempotent: true,
      costHint: "cheap",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
    async execute(args) {
      try {
        return ok(fn(args));
      } catch (e) {
        return err<ToolCallError>({
          code: "MOCK_ERROR",
          message: e instanceof Error ? e.message : String(e),
          retryable: false,
        });
      }
    },
  };
}

function makeRegistry(executors: ToolExecutor[]): ToolRegistryPort {
  const map = new Map(executors.map((e) => [e.definition.name, e]));
  return {
    register(executor) {
      map.set(executor.definition.name, executor);
    },
    get(name) {
      return map.get(name);
    },
    list() {
      return [...map.values()];
    },
    schemas() {
      return [...map.values()].map((e) => e.definition);
    },
  };
}

function makeSpec(
  name: string,
  chain: ComposedToolChainStep[],
  opts: Partial<Omit<ComposedToolSpec, "name" | "chain">> = {},
): ComposedToolSpec {
  return { name, description: `Test macro: ${name}`, chain, ...opts };
}

// ---------------------------------------------------------------------------
// validateComposedToolSpec — input validation
// ---------------------------------------------------------------------------

describe("validateComposedToolSpec — input validation", () => {
  it("throws when chain is empty", () => {
    expect(() => validateComposedToolSpec(makeSpec("macro", []))).toThrow(
      /at least one chain step/,
    );
  });

  it("accepts a single-step chain", () => {
    expect(() => validateComposedToolSpec(makeSpec("macro", [{ tool: "toolA" }]))).not.toThrow();
  });

  it("accepts a multi-step chain with no cycles", () => {
    expect(() =>
      validateComposedToolSpec(makeSpec("macro", [{ tool: "toolA" }, { tool: "toolB" }])),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateComposedToolSpec — cycle detection
// ---------------------------------------------------------------------------

describe("validateComposedToolSpec — cycle detection", () => {
  it("throws when a step references the spec itself (direct self-loop)", () => {
    expect(() => validateComposedToolSpec(makeSpec("macro", [{ tool: "macro" }]))).toThrow(/cycle/);
  });

  it("throws on a transitive cycle via knownComposed", () => {
    // macro → inner → macro
    const inner = makeSpec("inner", [{ tool: "macro" }]);
    const known = new Map([["inner", inner]]);
    expect(() => validateComposedToolSpec(makeSpec("macro", [{ tool: "inner" }]), known)).toThrow(
      /cycle/,
    );
  });

  it("does not throw for a two-level chain without cycle", () => {
    // macro → inner → toolX (no cycle)
    const inner = makeSpec("inner", [{ tool: "toolX" }]);
    const known = new Map([["inner", inner]]);
    expect(() =>
      validateComposedToolSpec(makeSpec("macro", [{ tool: "inner" }]), known),
    ).not.toThrow();
  });

  it("throws for a deeper transitive cycle (A → B → C → A)", () => {
    const cSpec = makeSpec("C", [{ tool: "A" }]);
    const bSpec = makeSpec("B", [{ tool: "C" }]);
    const known = new Map<string, ComposedToolSpec>([
      ["B", bSpec],
      ["C", cSpec],
    ]);
    expect(() => validateComposedToolSpec(makeSpec("A", [{ tool: "B" }]), known)).toThrow(/cycle/);
  });
});

// ---------------------------------------------------------------------------
// createComposedToolExecutor — basic execution
// ---------------------------------------------------------------------------

describe("createComposedToolExecutor — basic execution", () => {
  it("runs a single-step chain and returns the step output", async () => {
    const registry = makeRegistry([
      makeExecutor("double", (args) => ({ result: (args as { n: number }).n * 2 })),
    ]);
    const spec = makeSpec("macro", [{ tool: "double" }]);
    const executor = createComposedToolExecutor(spec, registry);

    const res = await executor.execute({ n: 5 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({ result: 10 });
    }
  });

  it("returns the final step output for a multi-step chain", async () => {
    const registry = makeRegistry([
      makeExecutor("addOne", (args) => ({ value: (args as { value: number }).value + 1 })),
      makeExecutor("double", (args) => ({ value: (args as { value: number }).value * 2 })),
    ]);

    const spec = makeSpec("macro", [
      { tool: "addOne", inputMapping: { value: "{{input.value}}" } },
      { tool: "double", inputMapping: { value: "{{steps[0].value}}" } },
    ]);

    const executor = createComposedToolExecutor(spec, registry);
    const res = await executor.execute({ value: 3 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // addOne(3) → 4, double(4) → 8
      expect(res.value).toEqual({ value: 8 });
    }
  });

  it("definition exposes the spec name and description", () => {
    const registry = makeRegistry([]);
    const spec = makeSpec("my-macro", [{ tool: "x" }], { description: "My macro tool" });
    const executor = createComposedToolExecutor(spec, registry);
    expect(executor.definition.name).toBe("my-macro");
    expect(executor.definition.description).toBe("My macro tool");
  });

  it("definition reflects dangerous and idempotent flags", () => {
    const registry = makeRegistry([]);
    const spec = makeSpec("macro", [{ tool: "x" }], { dangerous: true, idempotent: true });
    const executor = createComposedToolExecutor(spec, registry);
    expect(executor.definition.dangerous).toBe(true);
    expect(executor.definition.idempotent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createComposedToolExecutor — input mapping
// ---------------------------------------------------------------------------

describe("createComposedToolExecutor — input mapping", () => {
  it("passes raw workflow input when inputMapping is omitted", async () => {
    let received: unknown;
    const registry = makeRegistry([
      makeExecutor("echo", (args) => {
        received = args;
        return args;
      }),
    ]);

    const spec = makeSpec("macro", [{ tool: "echo" }]);
    await createComposedToolExecutor(spec, registry).execute({ x: 1, y: 2 });
    expect(received).toEqual({ x: 1, y: 2 });
  });

  it("resolves {{input.field}} from workflow input", async () => {
    let received: unknown;
    const registry = makeRegistry([
      makeExecutor("capture", (args) => {
        received = args;
        return {};
      }),
    ]);

    const spec = makeSpec("macro", [
      { tool: "capture", inputMapping: { a: "{{input.nested.value}}" } },
    ]);
    await createComposedToolExecutor(spec, registry).execute({ nested: { value: 42 } });
    expect(received).toEqual({ a: 42 });
  });

  it("resolves {{steps[0].field}} from a previous step's output", async () => {
    let secondInput: unknown;
    const registry = makeRegistry([
      makeExecutor("stepA", () => ({ id: "abc-123" })),
      makeExecutor("stepB", (args) => {
        secondInput = args;
        return {};
      }),
    ]);

    const spec = makeSpec("macro", [
      { tool: "stepA" },
      { tool: "stepB", inputMapping: { id: "{{steps[0].id}}" } },
    ]);
    await createComposedToolExecutor(spec, registry).execute({});
    expect(secondInput).toEqual({ id: "abc-123" });
  });

  it("resolves a mixed string template with literal text", async () => {
    let received: unknown;
    const registry = makeRegistry([
      makeExecutor("capture", (args) => {
        received = args;
        return {};
      }),
    ]);

    const spec = makeSpec("macro", [
      { tool: "capture", inputMapping: { label: "prefix-{{input.id}}-suffix" } },
    ]);
    await createComposedToolExecutor(spec, registry).execute({ id: "xyz" });
    expect(received).toEqual({ label: "prefix-xyz-suffix" });
  });

  it("resolves {{input}} (root) when no subpath given", async () => {
    let received: unknown;
    const registry = makeRegistry([
      makeExecutor("capture", (args) => {
        received = args;
        return {};
      }),
    ]);
    const spec = makeSpec("macro", [{ tool: "capture", inputMapping: { all: "{{input}}" } }]);
    await createComposedToolExecutor(spec, registry).execute({ a: 1 });
    expect(received).toEqual({ all: { a: 1 } });
  });
});

// ---------------------------------------------------------------------------
// createComposedToolExecutor — error propagation
// ---------------------------------------------------------------------------

describe("createComposedToolExecutor — error propagation", () => {
  it("returns err when a step tool is not found in the registry", async () => {
    const registry = makeRegistry([]);
    const spec = makeSpec("macro", [{ tool: "missing" }]);
    const executor = createComposedToolExecutor(spec, registry);

    const res = await executor.execute({});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("COMPOSED_TOOL_MISSING_STEP");
      expect(res.error.message).toMatch(/missing/);
    }
  });

  it("short-circuits and returns err when step 0 fails", async () => {
    let step1Called = false;
    const registry = makeRegistry([
      makeExecutor("failingTool", () => {
        throw new Error("step 0 exploded");
      }),
      makeExecutor("step1", () => {
        step1Called = true;
        return {};
      }),
    ]);

    const spec = makeSpec("macro", [{ tool: "failingTool" }, { tool: "step1" }]);
    const res = await createComposedToolExecutor(spec, registry).execute({});

    expect(res.ok).toBe(false);
    expect(step1Called).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("COMPOSED_TOOL_STEP_FAILED");
      expect(res.error.message).toMatch(/step 0 exploded/);
    }
  });

  it("propagates retryable flag from the failed step", async () => {
    const _registry = makeRegistry([]);
    // Override get to return an executor that returns a retryable err
    const customRegistry: ToolRegistryPort = {
      ...makeRegistry([]),
      get: () => ({
        definition: {
          name: "retryableTool",
          description: "",
          dangerous: false,
          idempotent: false,
          costHint: "cheap",
          inputSchema: {},
          outputSchema: {},
        },
        async execute() {
          return err<ToolCallError>({
            code: "UPSTREAM_ERR",
            message: "temporary failure",
            retryable: true,
          });
        },
      }),
    };

    const spec = makeSpec("macro", [{ tool: "retryableTool" }]);
    const res = await createComposedToolExecutor(spec, customRegistry).execute({});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.retryable).toBe(true);
    }
  });

  it("returns err immediately when signal is aborted before a step", async () => {
    let stepCalled = false;
    const registry = makeRegistry([
      makeExecutor("step", () => {
        stepCalled = true;
        return {};
      }),
    ]);

    const spec = makeSpec("macro", [{ tool: "step" }]);
    const controller = new AbortController();
    controller.abort();

    const res = await createComposedToolExecutor(spec, registry).execute({}, controller.signal);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("COMPOSED_TOOL_ABORTED");
    }
    expect(stepCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createComposedToolExecutor — three-step chain (integration scenario)
// ---------------------------------------------------------------------------

describe("createComposedToolExecutor — three-step chain", () => {
  it("threads outputs correctly across three steps", async () => {
    // Step 0: { name } → { greeting: "Hello, <name>!" }
    // Step 1: { greeting } → { upper: greeting.toUpperCase() }
    // Step 2: { upper, original: input.name } → { result: "<upper> from <name>" }
    const registry = makeRegistry([
      makeExecutor("greet", (args) => ({ greeting: `Hello, ${(args as { name: string }).name}!` })),
      makeExecutor("upper", (args) => ({
        upper: (args as { greeting: string }).greeting.toUpperCase(),
      })),
      makeExecutor("combine", (args) => {
        const { upper, original } = args as { upper: string; original: string };
        return { result: `${upper} from ${original}` };
      }),
    ]);

    const spec = makeSpec("pipeline", [
      { tool: "greet", inputMapping: { name: "{{input.name}}" } },
      { tool: "upper", inputMapping: { greeting: "{{steps[0].greeting}}" } },
      {
        tool: "combine",
        inputMapping: {
          upper: "{{steps[1].upper}}",
          original: "{{input.name}}",
        },
      },
    ]);

    const res = await createComposedToolExecutor(spec, registry).execute({ name: "World" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({ result: "HELLO, WORLD! from World" });
    }
  });
});
