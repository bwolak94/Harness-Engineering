/**
 * truncateResult — structure-preserving result truncation.
 *
 * Never a raw `.slice()`. If the JSON serialisation of `value` fits within
 * `maxChars`, it is returned as-is. If it exceeds the budget, the function
 * emits: head (N chars) … [TRUNCATED: M chars total, showing N] … tail (N chars).
 *
 * Head+tail strategy: the model sees both the beginning (likely keys/structure)
 * and the end (likely summary or last record) of a large response, giving it
 * enough context to understand the shape without the full payload.
 *
 * The truncation marker is a JSON comment-like string rather than a JSON object
 * so it does not break simple substring matching on the result.
 */
export function truncateResult(value: unknown, maxChars: number): string {
  const serialised = JSON.stringify(value, null, 2);

  if (serialised.length <= maxChars) {
    return serialised;
  }

  // Reserve space for the marker itself; each half gets ~40% of the budget.
  const markerTemplate = `\n…[TRUNCATED: ${serialised.length} chars total, showing ${maxChars}]…\n`;
  const halfBudget = Math.max(1, Math.floor((maxChars - markerTemplate.length) / 2));

  const head = serialised.slice(0, halfBudget);
  const tail = serialised.slice(serialised.length - halfBudget);
  const marker = `\n…[TRUNCATED: ${serialised.length} chars total, showing ${head.length + tail.length}]…\n`;

  return `${head}${marker}${tail}`;
}

/**
 * estimateTokens — rough character-to-token estimate (1 token ≈ 4 chars for English).
 * Used to convert a token budget into a character budget for truncation.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Convert a token budget to a character budget for use with truncateResult. */
export function tokenBudgetToChars(tokens: number): number {
  return tokens * 4;
}
