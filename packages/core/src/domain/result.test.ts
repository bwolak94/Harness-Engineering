import { describe, expect, it } from "vitest";
import { andThen, err, isErr, isOk, map, mapErr, ok, unwrap, unwrapOr } from "./result.js";

describe("ok", () => {
  it("creates an Ok with the given value", () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
  });

  it("works with null", () => {
    const r = ok(null);
    expect(r.ok).toBe(true);
    expect(r.value).toBeNull();
  });

  it("works with complex objects", () => {
    const v = { x: 1 };
    expect(ok(v).value).toBe(v);
  });
});

describe("err", () => {
  it("creates an Err with the given error", () => {
    const r = err("oops");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("oops");
  });

  it("works with Error objects", () => {
    const e = new Error("boom");
    expect(err(e).error).toBe(e);
  });
});

describe("map", () => {
  it("transforms the value inside Ok", () => {
    expect(map(ok(2), (x) => x * 3)).toEqual(ok(6));
  });

  it("passes Err through unchanged", () => {
    const e = err("bad");
    expect(map(e, (x: number) => x * 3)).toEqual(e);
  });
});

describe("mapErr", () => {
  it("transforms the error inside Err", () => {
    expect(mapErr(err(404), (code) => `HTTP ${code}`)).toEqual(err("HTTP 404"));
  });

  it("passes Ok through unchanged", () => {
    const r = ok(1);
    expect(mapErr(r, () => "transformed")).toEqual(r);
  });
});

describe("andThen", () => {
  it("chains Ok into the next function", () => {
    const parse = (s: string) => (s.length > 0 ? ok(s.length) : err("empty"));
    expect(andThen(ok("hello"), parse)).toEqual(ok(5));
  });

  it("short-circuits on Err, not calling the function", () => {
    let called = false;
    andThen(err("e"), () => {
      called = true;
      return ok(1);
    });
    expect(called).toBe(false);
  });

  it("propagates Err from the chained function", () => {
    expect(andThen(ok(""), (s) => (s.length > 0 ? ok(s) : err("empty")))).toEqual(err("empty"));
  });
});

describe("unwrapOr", () => {
  it("returns value from Ok", () => {
    expect(unwrapOr(ok(7), 0)).toBe(7);
  });

  it("returns fallback from Err", () => {
    expect(unwrapOr(err("x"), 99)).toBe(99);
  });
});

describe("unwrap", () => {
  it("returns value from Ok", () => {
    expect(unwrap(ok("val"))).toBe("val");
  });

  it("throws on Err", () => {
    expect(() => unwrap(err("fail"))).toThrow("fail");
  });
});

describe("isOk / isErr", () => {
  it("isOk returns true for Ok", () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isOk(err("x"))).toBe(false);
  });

  it("isErr returns true for Err", () => {
    expect(isErr(err("x"))).toBe(true);
    expect(isErr(ok(1))).toBe(false);
  });
});
