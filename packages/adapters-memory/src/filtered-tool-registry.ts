import type { ToolExecutor, ToolRegistryPort } from "@harness/core";

// ---------------------------------------------------------------------------
// FilteredToolRegistry — least-privilege view over a full ToolRegistryPort
//
// Each specialist agent is given a FilteredToolRegistry that exposes only the
// tools listed in AgentSpec.toolNames. The underlying registry is shared and
// never duplicated; this wrapper is just a read-only projection.
// ---------------------------------------------------------------------------

/**
 * FilteredToolRegistry — wraps a ToolRegistryPort and restricts visibility
 * to a named subset of tools.
 *
 * Used by MultiAgentService to build per-agent tool views without copying
 * executors. A specialist seeing 2-3 relevant tools picks the right one more
 * reliably than a generalist seeing all eleven.
 */
export class FilteredToolRegistry implements ToolRegistryPort {
  private readonly allowed: ReadonlySet<string>;

  constructor(
    private readonly inner: ToolRegistryPort,
    allowedNames: readonly string[],
  ) {
    this.allowed = new Set(allowedNames);
  }

  /** FilteredToolRegistry is read-only — registration is not supported. */
  register(_executor: ToolExecutor): void {
    throw new Error(
      "FilteredToolRegistry is read-only; register tools on the underlying registry.",
    );
  }

  get(name: string): ToolExecutor | undefined {
    if (!this.allowed.has(name)) return undefined;
    return this.inner.get(name);
  }

  list(): readonly ToolExecutor[] {
    return this.inner.list().filter((e) => this.allowed.has(e.definition.name));
  }

  schemas() {
    return this.list().map((e) => e.definition);
  }
}
