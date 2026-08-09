# ADR-0016 — Secrets, Egress, and Declarative Tools

**Date:** 2026-08-09
**Status:** Accepted
**Branch:** feat/16-secrets-and-egress
**Depends on:** ADR-0015 (multi-tenancy, RLS)

---

## Context

Tool definitions in T15 can reference external HTTP APIs via `spec.url`. Without controls:

1. **Secrets in plaintext** — API keys stored in the DB are a single-query exfiltration away.
2. **SSRF** — a misconfigured or malicious tool definition can make the server call `169.254.169.254` (AWS/GCP metadata), internal Redis, or other RFC1918 hosts.
3. **DNS rebinding** — an allowlisted public domain can be poisoned at resolve time to point at an internal host.
4. **Event log bloat** — tool responses can be arbitrarily large; storing them inline in `events.payload` JSONB collapses query performance.
5. **MCP interoperability** — teams want to expose external MCP servers without changing `HarnessRuntime`.

---

## Decision

### 1. Envelope Encryption (SecretPort + KmsPort)

- Every tenant has a set of named secrets. Each secret value is encrypted with a **Data Encryption Key (DEK)**.
- The DEK is itself encrypted (wrapped) by a **master key** held outside the DB (env var / future HSM).
- Schema: `tenant_deks(tenant_id, version, wrapped_key)` + `secrets(tenant_id, name, ciphertext, dek_version)`.
- **Rotation**: increment DEK version, create new `tenant_deks` row. Old secrets remain readable via old DEK. New secrets use the new DEK. No re-encryption needed.
- Encryption algorithm: AES-256-GCM. Each ciphertext is `base64(iv[12] ++ authTag[16] ++ ciphertext)`.

### 2. Secret References and Resolution

- Tool definitions may reference secrets as `{{secrets.NAME}}` in URLs and headers.
- These references are **never resolved** inside HarnessRuntime or event storage. Resolution happens exclusively in `EgressService.fetch()`, right before the HTTP request is made.
- After resolution, the plain value is never logged, traced, or stored.
- A `SecretRedactor` pure function strips known secret values from text (event payloads, log lines).

### 3. Ambassador / Egress Gateway (EgressPort → EgressService)

`EgressService` is the single outbound HTTP gateway:

1. Validate `allowedHosts` — reject hosts not on the per-tool allowlist.
2. Resolve DNS via the injected `lookup` function → get IP.
3. Check IP against blocked CIDRs: RFC1918 (10/8, 172.16/12, 192.168/16), loopback (127/8), link-local (169.254/16), metadata endpoints.
4. Resolve secrets (`{{secrets.X}}` substitution in URL and headers).
5. Perform HTTP request using a custom `https.Agent` that pins the connection to the pre-resolved IP (prevents TOCTOU DNS rebinding).
6. Apply response-size limit + timeout.
7. Claim check: if `body.length > threshold` (default 256 kB), upload to `BlobStorePort` and return a reference instead.

DNS lookup is injected to allow test mocking without monkey-patching `dns`.

### 4. Declarative Tool Builder

A `DeclarativeToolSpec` describes an HTTP tool declaratively:
- `method`, `urlTemplate` (with `{{input.field}}` and `{{secrets.X}}`), `headers`, `bodyTemplate`, `responseMapping` (JSONPath)
- `inputSchema` (Zod), `allowedHosts`, `dangerous`, `idempotent`

`createDeclarativeTool(spec, ports)` compiles this spec into a `Tool<unknown, unknown>` that passes the standard decorator stack (validation, timeout, policy, telemetry). Zero code generation — the DSL is interpreted, never executed.

The spec is validated at **save time** (`validateDeclarativeToolSpec`) and again at **call time**:
- Static SSRF check: reject literal RFC1918/link-local IP addresses or metadata hostnames in `urlTemplate`.
- Dynamic SSRF check: EgressService re-validates the resolved IP at connection time.

### 5. MCP Client Adapter

`createMcpTools(config, ports)` calls the MCP server's `tools/list` JSON-RPC endpoint, maps each tool descriptor to a `ToolDefinition`, and returns `Tool[]` implementations that call `tools/call`. The MCP server itself is just an EgressPort target — no special runtime changes.

### 6. Claim Check Pattern

Threshold: 256 kB. Larger responses:
- Uploaded to `BlobStorePort` with key `claims/{tenantId}/{workflowId}/{callId}`.
- Event payload stores `{ claimCheckRef: { bucket, key, sizeBytes } }` instead of the full body.
- Tool result returned to the model: first 500 chars + `[CLAIM CHECK: {sizeBytes} bytes stored at {key}]`.

---

## Consequences

**Positive:**
- Secret values never appear in Postgres event rows, OTEL traces, or Pino logs.
- SSRF is blocked in two layers (static + dynamic), with DNS-pinned connections.
- `HarnessRuntime` has zero changes — MCP tools use the same `ToolRegistryPort`.
- DEK rotation is zero-downtime: no bulk re-encryption.
- Event log stays lean: large tool responses are stored out of band.

**Negative / Trade-offs:**
- Additional round-trips per secret call (KMS unwrap + AES decrypt).
- Custom `https.Agent` with IP-pinned lookup is less ergonomic than plain `fetch`.
- `BlobStorePort` in core means tests must provide a `NoopBlobStorePort`.

## Rejected Alternatives

- **HashiCorp Vault / AWS KMS as hard dependency** — too heavy for a self-hosted tier; the `KmsPort` abstraction lets teams swap in a real KMS without touching domain code.
- **Network-level SSRF protection only (NetworkPolicy)** — K8s NetworkPolicy is the production defence; the application-level guard is defence-in-depth for misconfigured clusters.
- **Storing decrypted values in env per tool** — no rotation without redeploy; impossible to scope per tenant.
