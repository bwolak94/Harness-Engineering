// ---------------------------------------------------------------------------
// tool-cache-key — content-addressable key for tool result caching
//
// Pure JS implementation (no node:crypto) to comply with the zero-I/O
// constraint on packages/core (enforced via noNodejsModules: "error").
//
// Algorithm: FNV-1a 32-bit, XOR-folded to produce a stable hex string.
// Collision rate is negligible for typical tool payloads (< 10 KB).
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash of an arbitrary string.
 * Returns an 8-character lowercase hex string.
 *
 * Reference: http://www.isthe.com/chongo/tech/comp/fnv/#FNV-1a
 */
function fnv1a32(input: string): string {
  // FNV-1a 32-bit constants
  const FNV_PRIME = 0x01000193;
  const FNV_OFFSET_BASIS = 0x811c9dc5;

  let hash = FNV_OFFSET_BASIS;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Multiply by FNV prime, truncated to 32 bits
    // Emulate unsigned 32-bit with >>> 0
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Canonicalise an object to a deterministic JSON string.
 * Keys are sorted recursively so `{b:1,a:2}` and `{a:2,b:1}` produce the same string.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(",");

  return `{${sorted}}`;
}

/**
 * Build a content-addressable cache key for a tool call.
 *
 * Format: `<toolName>:<fnv1a32(toolName:canonicalJson(input))>`
 *
 * The tool name prefix lets `invalidateByTool` scan keys without decoding
 * the hash (the InMemoryToolCache stores entries under this key and can
 * filter by prefix).
 *
 * @param toolName - Name of the tool (e.g. "analyzeInvestment").
 * @param input    - The raw (unvalidated) tool arguments object.
 * @returns        8-char hex hash prefixed with the tool name.
 */
export function buildCacheKey(toolName: string, input: unknown): string {
  const payload = `${toolName}:${canonicalJson(input)}`;
  return `${toolName}:${fnv1a32(payload)}`;
}
