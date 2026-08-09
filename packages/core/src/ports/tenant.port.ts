/**
 * Tenant port — access model types and the port interface for tenant-scoped
 * operations. Kept in core so domain code can depend on the types without
 * pulling in Postgres or HTTP adapters.
 *
 * Pattern: Port (Hexagonal Architecture)
 * The concrete implementation lives in `@harness/adapters-postgres`.
 */

// ---------------------------------------------------------------------------
// RBAC roles — coarse-grained, ordered by privilege level
// ---------------------------------------------------------------------------

export type MemberRole = "owner" | "admin" | "member" | "viewer";

/** Privilege ordering: owner > admin > member > viewer. */
const ROLE_RANK: Record<MemberRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

/**
 * Returns true if `actual` satisfies the `required` minimum privilege level.
 * Use this instead of raw string comparisons so the hierarchy is enforced in
 * one place.
 */
export function hasRole(actual: MemberRole, required: MemberRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// ---------------------------------------------------------------------------
// Tenant context — extracted from JWT, attached to every inbound request
// ---------------------------------------------------------------------------

export interface TenantContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: MemberRole;
}

// ---------------------------------------------------------------------------
// Plan limits — enforced at workflow start and resource creation
// ---------------------------------------------------------------------------

export interface PlanLimits {
  plan: string;
  /** Maximum number of simultaneously active workflows for this tenant. */
  maxConcurrency: number;
  /** Maximum steps per workflow (overrides per-workflow budget when lower). */
  maxSteps: number;
  /** Maximum workflow runs per calendar month. */
  monthlyRuns: number;
  /** Event log retention in days; older partitions are dropped. */
  retentionDays: number;
  /** Maximum number of custom (declarative / MCP / webhook) tool definitions. */
  maxCustomTools: number;
}

// ---------------------------------------------------------------------------
// TenantPort
// ---------------------------------------------------------------------------

/**
 * TenantPort — queries tenant configuration and enforces plan limits.
 *
 * Implementations must execute queries inside a `withTenantCtx` transaction
 * so RLS applies correctly. The port intentionally does not expose mutation
 * methods — creating/updating tenants goes through dedicated admin routes.
 */
export interface TenantPort {
  /**
   * Returns the plan limits for the given tenant.
   * Throws if the tenant does not exist or has no plan entry.
   */
  getPlanLimits(tenantId: string): Promise<PlanLimits>;

  /**
   * Returns the number of workflows currently in `running` or `suspended`
   * status for the given tenant. Used to enforce `max_concurrency`.
   */
  getActiveConcurrency(tenantId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// NoopTenantPort — unlimited plan, used in tests and single-tenant mode
// ---------------------------------------------------------------------------

export class NoopTenantPort implements TenantPort {
  async getPlanLimits(_tenantId: string): Promise<PlanLimits> {
    return {
      plan: "unlimited",
      maxConcurrency: Number.MAX_SAFE_INTEGER,
      maxSteps: Number.MAX_SAFE_INTEGER,
      monthlyRuns: Number.MAX_SAFE_INTEGER,
      retentionDays: 365,
      maxCustomTools: Number.MAX_SAFE_INTEGER,
    };
  }

  async getActiveConcurrency(_tenantId: string): Promise<number> {
    return 0;
  }
}
