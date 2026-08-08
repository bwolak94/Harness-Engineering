import type { ModelMessage } from "./model.port.js";

/**
 * SummarizerPort — compresses evicted conversation history into a short string (T09).
 *
 * Called by HarnessRuntime when the context hydrator evicts messages beyond the
 * summarization threshold. The summary is stored in MemoryStore and written to
 * the event log as `context.summarized` so that resume replays it for free.
 *
 * Implementations:
 *   - NoopSummarizer (core)  — returns a placeholder; no model call. Default.
 *   - ModelSummarizer (adapters-llm, deferred) — calls a cheap model for real compression.
 */
export interface SummarizerPort {
  summarize(workflowId: string, messages: readonly ModelMessage[]): Promise<string>;
}

/**
 * NoopSummarizer — zero-I/O placeholder.
 *
 * Produces a deterministic stub string so tests pass without a real model.
 * The count of messages is included so the model knows history was compressed.
 */
export class NoopSummarizer implements SummarizerPort {
  async summarize(_workflowId: string, messages: readonly ModelMessage[]): Promise<string> {
    return `[Compressed summary of ${messages.length} earlier messages]`;
  }
}
