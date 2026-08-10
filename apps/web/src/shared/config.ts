// ---------------------------------------------------------------------------
// Shared configuration — base URLs derived from the current origin.
// No process.env in the browser; the server is co-hosted on the same origin.
// ---------------------------------------------------------------------------

export const API_BASE = import.meta.env.VITE_API_URL ?? "";
export const WS_BASE = import.meta.env.VITE_WS_URL ?? API_BASE.replace(/^http/, "ws");

export function wsStreamUrl(): string {
  const origin = WS_BASE || `ws://${window.location.host}`;
  return `${origin}/stream`;
}

// Dev-only JWT — read from VITE_DEV_TOKEN env var (set in .env, never commit the value).
// Replace with real auth flow (Keycloak PKCE) when wiring production auth.
export const DEV_TOKEN: string | null = import.meta.env.VITE_DEV_TOKEN ?? null;
