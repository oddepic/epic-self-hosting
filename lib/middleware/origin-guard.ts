const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const EXEMPT_PREFIXES = ["/api/webhooks/", "/api/jellyfin/refresh"];

export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export interface GuardRequest {
  method: string;
  pathname: string;
  origin: string | null;
  host: string | null;
}

export type GuardDecision = "allow" | "forbid";

/**
 * CSRF guard for browser-initiated mutations. Same-origin browser requests
 * always carry a matching `Origin`; a malicious cross-origin page or a direct
 * LAN request (no `Origin`) must be rejected. Server-to-server routes that
 * authenticate another way (the Jellyfin webhook) are exempt.
 */
export function guardMutatingRequest(req: GuardRequest): GuardDecision {
  if (!MUTATING_METHODS.has(req.method)) return "allow";
  if (EXEMPT_PREFIXES.some((prefix) => req.pathname.startsWith(prefix))) return "allow";
  if (isSameOrigin(req.origin, req.host)) return "allow";
  return "forbid";
}
