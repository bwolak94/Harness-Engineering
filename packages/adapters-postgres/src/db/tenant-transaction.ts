import type { Pool, PoolClient } from "pg";

/**
 * withTenantCtx — executes `fn` inside a Postgres transaction with:
 *
 *   SELECT set_config('app.tenant_id', '<tenantId>', true);
 *   SET LOCAL ROLE app_rw;
 *
 * This ensures every query in `fn` is subject to Row-Level Security. The
 * tenant_id setting is local to the transaction and resets on COMMIT/ROLLBACK,
 * making it safe to reuse connection pool clients.
 *
 * Pattern: Unit of Work
 * All reads and writes for a single business operation go through one call to
 * withTenantCtx. Callers receive the `PoolClient` directly so they can run
 * arbitrary queries without another round-trip to the pool.
 */
export async function withTenantCtx<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // set_config with is_local=true is transaction-scoped and accepts bind params.
    // SET LOCAL var = $1 is a syntax error in PostgreSQL — SET does not accept params.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query("SET LOCAL ROLE app_rw");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
