# ADR 0001 — Workspace Bootstrap and Toolchain

**Date:** 2026-08-07
**Status:** Accepted
**Deciders:** Project team / architect agent
**Task:** T00

## Context

We need to set up the monorepo scaffolding that will **enforce** architecture rather than merely describe it. Module boundary violations must fail the build, not code review. This is the foundation every subsequent task depends on.

Key forces:
- TypeScript `strict` mode + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` are non-negotiable (types are contracts between agents).
- `packages/core` must be completely free of I/O dependencies — this is the central architectural invariant.
- `process.env` access scattered through the codebase causes silent failures at runtime rather than fail-fast at startup.

## Decision

### Monorepo
- **pnpm workspaces** with `pnpm-workspace.yaml` covering `apps/*` and `packages/*`.
- TypeScript **project references** (`composite: true`) enforce compilation order and cross-package type checking without a bundler.

### Module boundaries
- **Biome** `noRestrictedImports` rule in the `packages/core/**` override blocks: `pg`, `drizzle-orm`, `ai`, `@ai-sdk/*`, `node:fs`, `node:net`.
- This is a linter error, not a warning — broken imports fail CI.

### TypeScript config
- `ESM only` (`"module": "NodeNext"`, `"verbatimModuleSyntax": true`).
- `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`.

### Environment validation
- Single `parseEnv()` function in `packages/contracts/src/env.ts` reads `process.env` exactly once.
- Uses Zod `safeParse` with human-readable error output before `process.exit(1)`.
- Composition root (`apps/server/src/main.ts`) is the only caller.

### Testing
- **Vitest** workspace config with per-package coverage thresholds: `core` at 90%, adapters at 70%.

### Quality gates
- **lefthook** pre-commit: Biome check on staged files + typecheck on changed packages.
- **commitlint** with `@commitlint/config-conventional` for Conventional Commits enforcement.

### Infrastructure
- `docker-compose.yml` with postgres:17, otel-collector, and jaeger for local observability.

### CI
- GitHub Actions matrix: Node 22 and 24.
- Steps: `typecheck → lint → test → build` (sequential, fail-fast).

## Consequences

- Breaking module boundaries now fails `pnpm lint` immediately — no grace period.
- Startup config errors surface with field names and format hints, not cryptic `undefined` stack traces.
- Every developer must run `pnpm install` before committing (lefthook is installed as a devDependency).
- Adding a new package requires: `package.json`, `tsconfig.json`, and an entry in the root `tsconfig.json` references array.

## Rejected alternatives

- **Turborepo / Nx** — additional complexity and learning curve not justified for this project's scale. pnpm workspaces + project references give us what we need without the magic.
- **ESLint + Prettier** — replaced by Biome: one process, ~10x faster, no plugin version conflicts.
- **Runtime env validation with dotenv** — dotenv doesn't validate, it just loads. Zod `safeParse` gives us typed output and explicit failure messages.
- **`.env` file checked in** — secrets must never be in the repo. `.env.example` documents the shape; `.env` is gitignored.
