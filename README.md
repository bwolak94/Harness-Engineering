# Harness Lab

Production-grade AI agent harness. The model is just a dependency — the runtime is the product.

## Prerequisites

- Node.js >= 22
- pnpm >= 9
- Docker (for Postgres + observability stack)

## Quick start

```bash
# 1. Install dependencies
pnpm install

# 2. Copy environment file and fill in required values
cp .env.example .env
# Edit .env: set DATABASE_URL and LLM_API_KEY at minimum

# 3. Start infrastructure
docker compose up -d

# 4. Verify database connection
pnpm db:ping

# 5. Type-check all packages
pnpm typecheck

# 6. Run tests
pnpm test

# 7. Build all packages
pnpm build

# 8. Start development server
pnpm --filter @harness/server dev
```

## Project structure

```
harness-lab/
├─ apps/
│  ├─ server/          # Fastify + WebSocket transport
│  └─ web/             # Harness Inspector (React, FSD)
├─ packages/
│  ├─ contracts/       # Zod schemas, types, env validation
│  ├─ core/            # Domain + ports (zero I/O)
│  ├─ adapters-memory/ # In-memory adapters (tests/dev)
│  ├─ adapters-postgres/  # Drizzle + Postgres adapters
│  ├─ adapters-llm/    # Vercel AI SDK behind ModelPort
│  ├─ adapters-sandbox/   # worker_threads sandbox
│  ├─ observability/   # OpenTelemetry setup
│  └─ evals/           # Golden set evaluation
├─ docs/adr/           # Architecture Decision Records
├─ infra/              # OTel collector config
└─ docker-compose.yml
```

## Architecture invariants

1. `packages/core` has **zero I/O dependencies** — no `pg`, no `ai`, no `fs`. Enforced by Biome `noRestrictedImports`.
2. `process.env` is read **exactly once** in the composition root via `parseEnv()` from `@harness/contracts/env`.
3. Domain errors are **values**, not exceptions — `Result<T, E>` across port boundaries.

## Observability

- Jaeger UI: [http://localhost:16686](http://localhost:16686)
- OTel collector metrics: [http://localhost:8888/metrics](http://localhost:8888/metrics)

## Development workflow

```bash
pnpm lint          # Biome check
pnpm lint:fix      # Biome check --write
pnpm typecheck     # tsc project references
pnpm test          # vitest run (all packages)
pnpm test:coverage # with coverage thresholds
```

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/). lefthook enforces this on `commit-msg`.

## Architecture decisions

See [`docs/adr/`](docs/adr/) for all Architecture Decision Records.
