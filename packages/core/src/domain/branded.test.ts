import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type StepId,
  type ToolName,
  type WorkflowId,
  asStepId,
  asToolName,
  asWorkflowId,
} from "./branded.js";

describe("branded types — nominal typing", () => {
  it("WorkflowId is not assignable to StepId at compile time", () => {
    // This test is intentionally a type-level assertion.
    // If WorkflowId === StepId, these would be equal types.
    expectTypeOf<WorkflowId>().not.toEqualTypeOf<StepId>();
  });

  it("StepId is not assignable to ToolName", () => {
    expectTypeOf<StepId>().not.toEqualTypeOf<ToolName>();
  });

  it("WorkflowId is not assignable to string via subtype", () => {
    // WorkflowId extends string but string does NOT extend WorkflowId
    expectTypeOf<string>().not.toEqualTypeOf<WorkflowId>();
  });

  it("asWorkflowId casts a string to WorkflowId", () => {
    const id = asWorkflowId("wf-123");
    expectTypeOf(id).toEqualTypeOf<WorkflowId>();
  });

  it("asStepId casts a string to StepId", () => {
    const id = asStepId("step-1");
    expectTypeOf(id).toEqualTypeOf<StepId>();
  });

  it("asToolName casts a string to ToolName", () => {
    const name = asToolName("analyzeInvestment");
    expectTypeOf(name).toEqualTypeOf<ToolName>();
  });

  it("runtime values are plain strings", () => {
    // At runtime, branded types are just strings — no overhead.
    const id = asWorkflowId("wf-42");
    expect(typeof id).toBe("string");
    expect(id).toBe("wf-42");
  });
});
