import type { ToolDefinition } from "@harness/contracts";
import type { ToolExecutor, ToolRegistryPort } from "@harness/core";

/**
 * InMemoryToolRegistry — in-memory implementation of ToolRegistryPort.
 *
 * Stores tool executors by name and enforces uniqueness at registration time.
 * Throws if the same tool name is registered twice — this is intentional:
 * duplicate registrations indicate a programming error, not a runtime condition.
 */
export class InMemoryToolRegistry implements ToolRegistryPort {
  private readonly executors = new Map<string, ToolExecutor>();

  register(executor: ToolExecutor): void {
    const name = executor.definition.name;
    if (this.executors.has(name)) {
      throw new Error(`Tool '${name}' is already registered. Each tool name must be unique.`);
    }
    this.executors.set(name, executor);
  }

  get(name: string): ToolExecutor | undefined {
    return this.executors.get(name);
  }

  list(): readonly ToolExecutor[] {
    return [...this.executors.values()];
  }

  schemas(): readonly ToolDefinition[] {
    return this.list().map((e) => e.definition);
  }

  /** Remove all registered tools — useful between tests. */
  clear(): void {
    this.executors.clear();
  }
}
