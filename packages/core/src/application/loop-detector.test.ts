import { describe, expect, it } from "vitest";
import { LoopDetector } from "./loop-detector.js";

describe("LoopDetector.record", () => {
  it("returns null for the first invocation", () => {
    const detector = new LoopDetector();
    expect(detector.record("myTool", { x: 1 })).toBeNull();
  });

  it("returns null for the second invocation", () => {
    const detector = new LoopDetector();
    detector.record("myTool", { x: 1 });
    expect(detector.record("myTool", { x: 1 })).toBeNull();
  });

  it("returns a corrective message on the third invocation (threshold=3)", () => {
    const detector = new LoopDetector(3);
    detector.record("myTool", { x: 1 });
    detector.record("myTool", { x: 1 });
    const msg = detector.record("myTool", { x: 1 });
    expect(msg).not.toBeNull();
    expect(msg).toContain("myTool");
    expect(msg).toContain("3");
  });

  it("continues returning corrective messages beyond threshold", () => {
    const detector = new LoopDetector(3);
    detector.record("t", {});
    detector.record("t", {});
    const third = detector.record("t", {});
    const fourth = detector.record("t", {});
    expect(third).not.toBeNull();
    expect(fourth).not.toBeNull();
  });

  it("treats different tools as independent", () => {
    const detector = new LoopDetector(3);
    detector.record("toolA", {});
    detector.record("toolA", {});
    // toolB has only 1 invocation — no loop yet
    expect(detector.record("toolB", {})).toBeNull();
  });

  it("treats different args as different invocations (no loop)", () => {
    const detector = new LoopDetector(3);
    detector.record("myTool", { x: 1 });
    detector.record("myTool", { x: 2 });
    // different args → no loop
    expect(detector.record("myTool", { x: 3 })).toBeNull();
  });

  it("normalises object key order for arg comparison", () => {
    const detector = new LoopDetector(3);
    detector.record("myTool", { b: 2, a: 1 });
    detector.record("myTool", { a: 1, b: 2 });
    const msg = detector.record("myTool", { a: 1, b: 2 });
    // same logical args, different key order → still counts as a loop
    expect(msg).not.toBeNull();
  });

  it("custom threshold works", () => {
    const detector = new LoopDetector(2);
    detector.record("t", {});
    const msg = detector.record("t", {});
    expect(msg).not.toBeNull();
  });
});

describe("LoopDetector.reset", () => {
  it("clears all counters", () => {
    const detector = new LoopDetector(3);
    detector.record("t", {});
    detector.record("t", {});
    detector.reset();
    detector.record("t", {});
    detector.record("t", {});
    // After reset, count starts from zero again
    expect(detector.record("t", {})).not.toBeNull(); // third call after reset
  });
});

describe("LoopDetector.getCount", () => {
  it("returns 0 for unseen tool", () => {
    const detector = new LoopDetector();
    expect(detector.getCount("unseen", {})).toBe(0);
  });

  it("returns the correct invocation count", () => {
    const detector = new LoopDetector();
    detector.record("t", { a: 1 });
    detector.record("t", { a: 1 });
    expect(detector.getCount("t", { a: 1 })).toBe(2);
  });
});
