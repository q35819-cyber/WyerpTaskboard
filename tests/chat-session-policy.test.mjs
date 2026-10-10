import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REQUESTS_PER_SESSION,
  SOFT_WARNING_AT,
  normalizeRoleSessions,
  routeForRole,
  executionStarted
} from "../browser-extension/chat-wake/session-policy.mjs";

test("same role reuses its existing chat through request 20", () => {
  const url = "https://chatgpt.com/c/dev-session";
  for (let count = 0; count < 20; count++) {
    const sessions = normalizeRoleSessions({ developer_ai: { url, count } });
    const route = routeForRole("developer_ai", sessions);
    assert.equal(route.allowed, true);
    assert.equal(route.newSession, false);
    assert.equal(route.url, url);
    assert.equal(route.requestCount, count + 1);
  }
});

test("request 21 replaces only that role session", () => {
  const devUrl = "https://chatgpt.com/c/dev-old";
  const testUrl = "https://chatgpt.com/c/test-stays";
  const sessions = normalizeRoleSessions({
    developer_ai: { url: devUrl, count: MAX_REQUESTS_PER_SESSION },
    test_ai: { url: testUrl, count: 7 }
  });
  const dev = routeForRole("developer_ai", sessions);
  assert.equal(dev.newSession, true);
  assert.equal(dev.url, "https://chatgpt.com/");
  assert.equal(dev.requestCount, 1);
  const qa = routeForRole("test_ai", sessions);
  assert.equal(qa.newSession, false);
  assert.equal(qa.url, testUrl);
  assert.equal(qa.requestCount, 8);
  assert.deepEqual(Object.keys(sessions).sort(), ["developer_ai", "test_ai"]);
});

test("soft warning begins at 15 and hard switch remains 20", () => {
  const url = "https://chatgpt.com/c/dev-session";
  assert.equal(SOFT_WARNING_AT, 15);
  assert.equal(MAX_REQUESTS_PER_SESSION, 20);
  assert.equal(routeForRole("developer_ai", { developer_ai: { url, count: 13 } }).softWarning, false);
  assert.equal(routeForRole("developer_ai", { developer_ai: { url, count: 14 } }).softWarning, true);
  assert.equal(routeForRole("developer_ai", { developer_ai: { url, count: 19 } }).newSession, false);
  assert.equal(routeForRole("developer_ai", { developer_ai: { url, count: 20 } }).newSession, true);
});

test("execution gate requires consumed_at and claim_event_id", () => {
  assert.equal(executionStarted({ consumed: false, consumed_at: null, claim_event_id: null }), false);
  assert.equal(executionStarted({ consumed: true, consumed_at: "2026-09-29T00:00:00Z", claim_event_id: null }), false);
  assert.equal(executionStarted({ consumed: true, consumed_at: null, claim_event_id: "evt_1" }), false);
  assert.equal(executionStarted({ consumed: true, consumed_at: "2026-09-29T00:00:00Z", claim_event_id: "evt_1" }), true);
});

test("configurable chat maximum and warning threshold are honored", () => {
  const url = "https://chatgpt.com/c/dev-configurable";
  const policy = { max_requests_per_chat: 30, context_warning_at: 22 };
  const beforeWarning = routeForRole("developer_ai", { developer_ai: { url, count: 20 } }, policy);
  assert.equal(beforeWarning.newSession, false);
  assert.equal(beforeWarning.requestCount, 21);
  assert.equal(beforeWarning.softWarning, false);

  const warning = routeForRole("developer_ai", { developer_ai: { url, count: 21 } }, policy);
  assert.equal(warning.requestCount, 22);
  assert.equal(warning.softWarning, true);

  const request30 = routeForRole("developer_ai", { developer_ai: { url, count: 29 } }, policy);
  assert.equal(request30.newSession, false);
  assert.equal(request30.requestCount, 30);

  const request31 = routeForRole("developer_ai", { developer_ai: { url, count: 30 } }, policy);
  assert.equal(request31.newSession, true);
  assert.equal(request31.requestCount, 1);
});
