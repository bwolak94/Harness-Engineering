import { parseEnv } from "@harness/contracts/env";

// Composition root — the only place process.env is accessed.
const env = parseEnv();

console.log(`[harness] starting server on ${env.HOST}:${env.PORT} (${env.NODE_ENV})`);

// TODO(T04): mount Fastify + WebSocket gateway
