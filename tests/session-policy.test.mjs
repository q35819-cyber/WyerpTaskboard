import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_ROLES,
  SOFT_WARNING_AT,
  MAX_REQUESTS_PER_SESSION,
  normalizeRoleSessions,
  routeForRole,
  executionStarted
} from "../browser-extension/chat-wake/session-policy.mjs";

test("session policy constants are 15 soft / 20 hard and exactly two roles", () => {
  assert.equal(SOFT_WARNING_AT, 15);
  assert.equal(MAX_REQUESTS_PER_SESSION, 20);
  assert.deepEqual(CHAT_ROLES, ["developer_ai", "test_ai"]);
});

test("requests 2 through 20 reuse the same developer conversation URL", () => {
  const url = "https://chatgpt.com/c/dev-session-1";
  for (let currentCount = 1; currentCount < 20; currentCount++) {
    const decision = routeForRole("developer_ai", {
      developer_ai: { url, count: currentCount }
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.newSession, false);
    assert.equal(decision.url, url);
    assert.equal(decision.requestCount, currentCount + 1);
    assert.equal(decision.softWarning, currentCount + 1 >= 15);
  }
});

test("request 21 replaces only that role session", () => {
  const sessions = {
    developer_ai: { url: "https://chatgpt.com/c/dev-old", count: 20 },
    test_ai: { url: "https://chatgpt.com/c/test-stable", count: 8 }
  };
  const dev = routeForRole("developer_ai", sessions);
  assert.equal(dev.newSession, true);
  assert.equal(dev.url, "https://chatgpt.com/");
  assert.equal(dev.requestCount, 1);

  const testRole = routeForRole("test_ai", sessions);
  assert.equal(testRole.newSession, false);
  assert.equal(testRole.url, "https://chatgpt.com/c/test-stable");
  assert.equal(testRole.requestCount, 9);
});

test("normalization keeps at most developer/test role slots and preserves observed count", () => {
  const sessions = normalizeRoleSessions({
    developer_ai: { url: "https://chatgpt.com/c/dev", count: 99 },
    test_ai: { url: "https://chatgpt.com/c/test", count: 7 },
    third_role: { url: "https://chatgpt.com/c/third", count: 1 }
  });
  assert.deepEqual(Object.keys(sessions).sort(), ["developer_ai", "test_ai"]);
  assert.equal(sessions.developer_ai.count, 99);
  assert.equal(sessions.test_ai.count, 7);
});

test("next candidate is released only after a real consumed claim event exists", () => {
  assert.equal(executionStarted(null), false);
  assert.equal(executionStarted({ consumed: true }), false);
  assert.equal(executionStarted({
    consumed: true,
    consumed_at: "2026-09-29T00:00:00.000Z",
    claim_event_id: null
  }), false);
  assert.equal(executionStarted({
    consumed: true,
    consumed_at: "2026-09-29T00:00:00.000Z",
    claim_event_id: "evt_claim_123"
  }), true);
});
