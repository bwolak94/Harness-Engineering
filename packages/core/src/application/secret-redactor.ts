/**
 * secretRedactor — pure utilities for scrubbing secret values from text.
 *
 * Used to sanitise:
 *  - event payload JSON strings before they are written to the event log
 *  - tool result strings before they are added to the conversation
 *  - log lines before they leave the process
 *
 * Pattern: pure functions — no I/O, no side effects.
 * The redactor receives the current resolved plaintext values for a tenant
 * (already decrypted by SecretPort) so it can do exact-match replacement.
 * It also removes common credential patterns (Bearer tokens, API keys).
 */

const REDACTED = "[REDACTED]";

// ---------------------------------------------------------------------------
// Known credential patterns (conservative — only clear-signal patterns)
// ---------------------------------------------------------------------------

const CREDENTIAL_PATTERNS: RegExp[] = [
  // Bearer tokens in Authorization-style header values
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  // Generic "key": "sk-..." OpenAI-style keys
  /sk-[A-Za-z0-9]{20,}/g,
  // AWS access key IDs
  /AKIA[A-Z0-9]{16}/g,
  // AWS secret access keys (40 base64 chars after "=" assignment)
  /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*=\s*[A-Za-z0-9/+]{40}/gi,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Replace every occurrence of each `secretValues` string with `[REDACTED]`.
 * Also applies known credential pattern scrubbing.
 *
 * Returns the original `text` unchanged if `secretValues` is empty and no
 * pattern matches — no allocation in the hot path.
 */
export function redactSecrets(text: string, secretValues: readonly string[]): string {
  let result = text;

  // Exact-match replacement for known secret values (longest first to avoid
  // partial replacement of a longer value by a substring match)
  const sorted = [...secretValues].sort((a, b) => b.length - a.length);
  for (const value of sorted) {
    if (value.length === 0) continue;
    // Use split/join to avoid the need to escape special regex characters
    result = result.split(value).join(REDACTED);
  }

  // Pattern-based scrubbing
  for (const pattern of CREDENTIAL_PATTERNS) {
    // Reset lastIndex because the patterns are stateful (global flag)
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }

  return result;
}

/**
 * Redact secrets from a JSON-serialisable value.
 * Deep-serialises the value to JSON, redacts, then re-parses.
 * Returns the sanitised object (or string if parsing fails).
 */
export function redactSecretsInObject(value: unknown, secretValues: readonly string[]): unknown {
  const json = JSON.stringify(value);
  const redacted = redactSecrets(json, secretValues);
  if (redacted === json) return value; // short-circuit — nothing changed
  try {
    return JSON.parse(redacted) as unknown;
  } catch {
    // Redaction broke JSON structure (secret was a key/value boundary) — return string
    return redacted;
  }
}
