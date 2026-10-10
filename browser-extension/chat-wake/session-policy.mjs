export const CHAT_ROLES = Object.freeze(["developer_ai", "test_ai"]);
export const SOFT_WARNING_AT = 15;
export const MAX_REQUESTS_PER_SESSION = 20;

export function normalizeRoleSessions(raw = {}) {
  const out = {};
  for (const role of CHAT_ROLES) {
    const value = raw?.[role];
    const url = /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+/.test(String(value?.url || "")) ? String(value.url) : null;
    const count = Number(value?.count || 0);
    if (url) out[role] = { url, count: Number.isInteger(count) ? Math.max(0, count) : 0 };
  }
  return out;
}

export function routeForRole(role, sessions = {}, settings = {}) {
  if (!CHAT_ROLES.includes(role)) return { allowed: false, reason: "invalid_role" };
  const maxRequests = Math.max(1, Number(settings.max_requests_per_chat || MAX_REQUESTS_PER_SESSION));
  const warningAt = Math.max(1, Math.min(maxRequests, Number(settings.context_warning_at || SOFT_WARNING_AT)));
  const session = sessions[role] || null;
  if (session?.url && Number(session.count || 0) < maxRequests) {
    const requestCount = Number(session.count || 0) + 1;
    return {
      allowed: true,
      newSession: false,
      url: session.url,
      requestCount,
      softWarning: requestCount >= warningAt
    };
  }
  return {
    allowed: true,
    newSession: true,
    url: "https://chatgpt.com/",
    requestCount: 1,
    softWarning: false
  };
}

export function executionStarted(status) {
  return Boolean(status?.consumed && status?.consumed_at && status?.claim_event_id);
}
