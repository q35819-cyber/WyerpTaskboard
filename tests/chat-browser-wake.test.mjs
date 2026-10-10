import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { ChatBrowserWake } from "../server/chat-browser-wake.mjs";


async function readContentScriptUiStateFixture({
  bannerText,
  bannerClass = "",
  systemErrorText = "",
  userMessageText = "",
  extensionVersion = "0.6.15",
  latestExtensionVersion = extensionVersion,
  compatible = true
}) {
  const root = path.resolve(import.meta.dirname, "..");
  const source = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "content.js"), "utf8");
  let messageListener = null;

  const composer = {
    value: "",
    innerText: "",
    textContent: "",
    focus() {},
    dispatchEvent() {},
    getAttribute() { return null; }
  };
  const stop = {
    disabled: false,
    innerText: "",
    textContent: "",
    className: "",
    parentElement: null,
    getAttribute(name) { return name === "aria-label" ? "停止" : null; },
    querySelector() { return null; }
  };
  const bannerParent = {
    className: bannerClass,
    parentElement: null,
    getAttribute(name) { return name === "class" ? this.className : null; },
    querySelector() { return null; }
  };
  const banner = {
    innerText: bannerText,
    textContent: bannerText,
    className: "",
    parentElement: bannerParent,
    getAttribute() { return null; },
    querySelector() { return null; },
    closest(selector) { return selector === "pre,code" ? null : null; }
  };
  const turn = {
    className: "",
    parentElement: null,
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === "div,span,p" ? [banner] : []; }
  };
  bannerParent.parentElement = turn;
  const assistant = {
    closest() { return turn; },
    getAttribute() { return null; }
  };

  const systemError = {
    innerText: systemErrorText,
    textContent: systemErrorText,
    closest() { return null; }
  };
  const userMessage = {
    innerText: userMessageText,
    textContent: userMessageText,
    closest(selector) {
      return /conversation-turn|data-message-author-role|prompt-textarea|contenteditable|pre,code/.test(String(selector)) ? this : null;
    }
  };
  const topLevelSurfaceSelector = '[data-testid*="toast"]';
  const document = {
    querySelector(selector) {
      if (selector === "#prompt-textarea") return composer;
      if (selector === 'button[data-testid="stop-button"]') return stop;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "button" || selector === "a,button") return [stop];
      if (selector === '[data-message-author-role="assistant"]') return [assistant];
      if (selector === topLevelSurfaceSelector) {
        return [
          ...(systemErrorText ? [systemError] : []),
          ...(userMessageText ? [userMessage] : [])
        ];
      }
      return [];
    }
  };

  const session = new Map();
  const sentMessages = [];
  const context = {
    WYERP_CHAT_WAKE_CONFIG: { token: "t".repeat(64), baseUrl: "http://127.0.0.1:47831/api/chat-wake" },
    chrome: {
      runtime: {
        getManifest: () => ({ version: extensionVersion }),
        onMessage: { addListener(fn) { messageListener = fn; } },
        sendMessage: async (message) => {
          sentMessages.push(message);
          return message?.type === "WYERP_REGISTER_DISPATCHER"
            ? { dispatcher: false, dispatcher_epoch: 0 }
            : { ok: true };
        }
      }
    },
    document,
    location: {
      pathname: "/c/fixture-123",
      href: "https://chatgpt.com/c/fixture-123",
      origin: "https://chatgpt.com"
    },
    sessionStorage: {
      getItem(key) { return session.get(key) || null; },
      setItem(key, value) { session.set(key, value); }
    },
    crypto: { randomUUID: () => "fixture-client" },
    fetch: async () => ({
      ok: compatible,
      json: async () => ({
        compatible,
        taskboard_version: "0.6.13",
        extension_latest_version: latestExtensionVersion
      })
    }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URLSearchParams
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.ok(messageListener, "content script should register runtime message listener");
  let observed = null;
  messageListener({ type: "WYERP_READ_CHAT_STATE" }, null, value => { observed = value; });
  const dispatchMessage = message => {
    let reply;
    messageListener(message, null, value => { reply = value; });
    return reply;
  };
  const v2 = dispatchMessage({ type: "WYERP_READ_CHAT_STATE_V2" });
  return { ...observed, sentMessages, v2, dispatchMessage };
}

async function runExecutionErrorRecoveryFixture({ allowAutomation = false } = {}) {
  const root = path.resolve(import.meta.dirname, "..");
  const source = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "content.js"), "utf8");
  let errorActive = true;
  let retryClicks = 0;
  const heartbeats = [];
  const automationRequests = [];
  const mcpActions = [];
  const listeners = [];
  const retry = {
    disabled: false,
    innerText: "重试",
    textContent: "重试",
    getAttribute(name) { return name === "aria-label" ? "重试" : null; },
    click() { retryClicks += 1; errorActive = false; }
  };
  const alert = {
    innerText: "请求超时",
    textContent: "请求超时",
    className: "text-token-text-secondary",
    parentElement: null,
    getAttribute(name) { return name === "role" ? "alert" : null; },
    querySelector() { return null; },
    closest() { return null; }
  };
  const composer = {
    value: "",
    innerText: "",
    textContent: "",
    focus() {},
    dispatchEvent() {}
  };
  const document = {
    querySelector(selector) {
      if (selector === "#prompt-textarea") return composer;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[role="alert"]') return errorActive ? [alert] : [];
      if (selector === "button" || selector === "a,button") return [retry];
      return [];
    }
  };
  class FakeEventSource {
    addEventListener() {}
    close() {}
  }
  const session = new Map();
  const context = {
    WYERP_CHAT_WAKE_CONFIG: { token: "t".repeat(64), baseUrl: "http://127.0.0.1:47831/api/chat-wake" },
    chrome: {
      runtime: {
        getManifest: () => ({ version: "0.6.15" }),
        onMessage: { addListener(fn) { listeners.push(fn); } },
        sendMessage: async message => message?.type === "WYERP_REGISTER_DISPATCHER"
          ? { dispatcher: true, dispatcher_epoch: 1500 }
          : { ok: true }
      }
    },
    document,
    location: {
      pathname: "/c/timeout-fixture",
      href: "https://chatgpt.com/c/timeout-fixture",
      origin: "https://chatgpt.com"
    },
    sessionStorage: {
      getItem(key) { return session.get(key) || null; },
      setItem(key, value) { session.set(key, value); }
    },
    crypto: { randomUUID: () => "timeout-client" },
    fetch: async (url, options = {}) => {
      if (String(url).includes("/ui-heartbeat")) {
        heartbeats.push(JSON.parse(options.body || "{}"));
        return { ok: true, json: async () => ({ state: "heartbeat" }) };
      }
      if (String(url).includes("/mcp-action")) {
        const action = JSON.parse(options.body || "{}");
        mcpActions.push(action);
        if (allowAutomation) errorActive = false;
        return {
          ok: true,
          json: async () => allowAutomation
            ? { ok: true, executed: true, attempted: true, state: "executed" }
            : { ok: false, executed: false, attempted: false, state: "approval_required" }
        };
      }
      if (String(url).includes("/api/automation-control/request")) {
        automationRequests.push(JSON.parse(options.body || "{}"));
        return {
          ok: true,
          json: async () => ({
            allowed: allowAutomation,
            state: allowAutomation ? "allowed" : "approval_required",
            mode: allowAutomation ? "unattended" : "manual_approval"
          })
        };
      }
      return {
        ok: true,
        json: async () => ({
          compatible: true,
          taskboard_version: "0.6.13",
          extension_latest_version: "0.6.15"
        })
      };
    },
    EventSource: FakeEventSource,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    URLSearchParams
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  await new Promise(resolve => setTimeout(resolve, 4200));
  return { retryClicks, heartbeats, automationRequests, mcpActions, listeners };
}

async function createBackgroundCheckpointHarness(storage = {}) {
  const root = path.resolve(import.meta.dirname, "..");
  const source = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "background.js"), "utf8");
  let messageListener = null;
  const scheduled = [];
  const chrome = {
    runtime: {
      getManifest: () => ({ version: "0.6.15" }),
      reload() {},
      onMessage: { addListener(fn) { messageListener = fn; } }
    },
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return { [key]: storage[key] };
          return { ...storage };
        },
        async set(values) { Object.assign(storage, JSON.parse(JSON.stringify(values))); },
        async remove(key) { delete storage[key]; }
      }
    },
    tabs: {
      async query() { return []; },
      async get(tabId) { return { id: tabId, url: "https://chatgpt.com/c/checkpoint" }; },
      async sendMessage(_tabId, message) {
        if (message?.type === "WYERP_READ_CHAT_STATE") {
          return {
            ok: true,
            switch_safe: false,
            is_new_chat: false,
            conversation_url: "https://chatgpt.com/c/checkpoint",
            href: "https://chatgpt.com/c/checkpoint"
          };
        }
        return { ok: true };
      },
      async update() { return {}; },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} }
    },
    scripting: { async executeScript() {} }
  };
  const context = {
    chrome,
    setTimeout(fn, ms) { scheduled.push({ fn, ms }); return scheduled.length; },
    clearTimeout() {},
    Date,
    Map,
    Set,
    Object,
    Number,
    String,
    Boolean,
    RegExp,
    Promise
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  await new Promise(resolve => setTimeout(resolve, 0));
  async function dispatch(message, tabId = 7) {
    let response = null;
    messageListener(message, { tab: { id: tabId } }, value => { response = value; });
    await new Promise(resolve => setTimeout(resolve, 0));
    return response;
  }
  return { storage, dispatch, scheduled };
}

test("chat browser wake leases one eligible candidate and acks it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-chat-wake-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "config", "chat-browser-wake.json"), JSON.stringify({
    version: 1, enabled: true, token: "a".repeat(64), lease_ms: 30000
  }));
  let now = Date.parse("2026-09-29T00:00:00Z");
  const wake = await new ChatBrowserWake(root, { clock: () => now }).init();
  assert.equal(wake.verifyToken("a".repeat(64)), true);
  assert.equal(wake.verifyToken("b".repeat(64)), false);
  const candidates = [{
    eligible: true,
    project_id: "wyerp-taskboard",
    task_id: "WTB-TEST-001",
    detection_id: "det_abc123",
    eligible_role: "test_ai",
    extra_secret: "must_not_leak"
  }];
  const first = await wake.claim(candidates, "client-a", null, 100);
  assert.equal(first.state, "candidate");
  assert.deepEqual(Object.keys(first.candidate).sort(), ["detection_id","eligible_role","project_id","task_id"]);
  const other = await wake.claim(candidates, "client-b", null, 100);
  assert.equal(other.state, "superseded");
  const same = await wake.claim(candidates, "client-a", null, 100);
  assert.equal(same.state, "candidate");
  const ack = await wake.ack("det_abc123", "client-a", { dispatcher_epoch: 100 });
  assert.equal(ack.state, "acked");
  const done = await wake.claim(candidates, "client-a", null, 100);
  assert.equal(done.state, "no_candidate");
});

test("newer dispatcher epoch immediately supersedes an active stale lease", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-chat-wake-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "config", "chat-browser-wake.json"), JSON.stringify({
    version: 1, enabled: true, token: "c".repeat(64), lease_ms: 30000
  }));
  const wake = await new ChatBrowserWake(root, { clock: () => 100000 }).init();
  const candidates = [{ eligible:true, project_id:"wyerp-taskboard", task_id:"WTB-DOC-001", detection_id:"det_epoch", eligible_role:"test_ai" }];
  assert.equal((await wake.claim(candidates, "client-old", null, 100)).state, "candidate");
  assert.equal((await wake.claim(candidates, "client-new", null, 200)).state, "candidate");
  assert.equal((await wake.claim(candidates, "client-old", null, 100)).state, "superseded");
  assert.equal((await wake.ack("det_epoch", "client-old", { dispatcher_epoch: 100 })).state, "superseded");
  assert.equal((await wake.ack("det_epoch", "client-new", { dispatcher_epoch: 200 })).state, "acked");
});

test("browser extension contract is chatgpt-only and uses minimal candidate fields", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const manifest = JSON.parse(await fs.readFile(path.join(root, "browser-extension", "chat-wake", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://chatgpt.com/*"]);
  const content = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "content.js"), "utf8");
  const executor = await fs.readFile(path.join(root, "server", "chatgpt-mcp-executor.mjs"), "utf8");
  for (const field of ["project_id","task_id","detection_id","eligible_role"]) assert.match(content, new RegExp(field));
  for (const forbidden of ["cookie","localStorage","document.body.innerText","测试报告","源码"]) assert.equal(content.includes(forbidden), false);
  assert.match(content, /dispatcher_epoch/);
  assert.match(content, /addEventListener\("superseded"/);
  assert.match(executor, /taskctl complete/);
  assert.match(executor, /taskctl test-result --result pass\|fail\|blocked/);
  assert.match(executor, /禁止再用手工transition\+release/);
});


test("role filter only returns matching candidate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-chat-wake-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "config", "chat-browser-wake.json"), JSON.stringify({
    version: 1, enabled: true, token: "d".repeat(64), lease_ms: 30000
  }));
  const wake = await new ChatBrowserWake(root).init();
  const candidates = [
    { eligible:true, project_id:"wyerp-taskboard", task_id:"DEV-1", detection_id:"det_dev", eligible_role:"developer_ai" },
    { eligible:true, project_id:"wyerp-taskboard", task_id:"TEST-1", detection_id:"det_test", eligible_role:"test_ai" }
  ];
  assert.equal((await wake.claim(candidates, "client-dispatcher", "test_ai", 400)).candidate.task_id, "TEST-1");
  assert.equal((await wake.claim(candidates, "client-dispatcher", "developer_ai", 400)).candidate.task_id, "DEV-1");
});

test("delivery waits for explicit candidate-started acknowledgement", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const background = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "background.js"), "utf8");
  const content = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "content.js"), "utf8");
  assert.match(background, /WYERP_ROLE_CANDIDATE_STARTED/);
  assert.match(background, /!current.delivered/);
  assert.match(background, /WYERP_READ_CHAT_STATE/);
  assert.match(background, /state\.switch_safe/);
  assert.match(content, /type: "WYERP_ROLE_CANDIDATE_STARTED"/);
});

test("delivery retry does not expire while the same candidate is still active", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const background = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "background.js"), "utf8");
  assert.match(background, /function scheduleDeliveryRetry\(tabId, delayMs\)/);
  assert.match(background, /current && !current\.delivered && tabId === dispatcherTabId/);
  assert.match(background, /scheduleDeliveryRetry\(tabId, 2500\)/);
  assert.match(background, /scheduleDeliveryRetry\(tabId, 500\)/);
  assert.doesNotMatch(background, /attempt < 20/);
  assert.match(background, /dispatcher_epoch: dispatcherEpoch/);
  assert.match(background, /restoreDispatcherEpoch/);
});

test("dispatcher heartbeat is persisted and refreshed at a bounded cadence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-chat-wake-heartbeat-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "config", "chat-browser-wake.json"), JSON.stringify({
    version: 1, enabled: true, token: "h".repeat(64), lease_ms: 30000, expected_extension_version: "0.6.4"
  }));
  let now = Date.parse("2026-09-29T09:00:00Z");
  const wake = await new ChatBrowserWake(root, { clock: () => now }).init();

  await wake.claim([], "client-heartbeat", "developer_ai", 900);
  const first = await wake.readState();
  assert.equal(first.dispatcher.client_id, "client-heartbeat");
  assert.equal(first.dispatcher.dispatcher_epoch, 900);
  assert.equal(first.dispatcher.role, "developer_ai");
  const firstSeen = first.dispatcher.last_seen_at_ms;

  now += 10_000;
  await wake.claim([], "client-heartbeat", "developer_ai", 900);
  assert.equal((await wake.readState()).dispatcher.last_seen_at_ms, firstSeen);

  now += 31_000;
  await wake.claim([], "client-heartbeat", "developer_ai", 900);
  assert.equal((await wake.readState()).dispatcher.last_seen_at_ms, now);
});

test("session switching is read-before-act and delegates every GPT mutation to MCP", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const background = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "background.js"), "utf8");
  const content = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "content.js"), "utf8");
  assert.match(background, /WYERP_READ_CHAT_STATE/);
  assert.match(background, /state\.switch_safe/);
  assert.match(background, /requestMcpAction\("new_chat"/);
  assert.match(background, /requestMcpAction\("navigate_session"/);
  assert.match(content, /function readChatState\(\)/);
  assert.doesNotMatch(content, /WYERP_CLICK_NEW_CHAT/);
  assert.doesNotMatch(content, /clickNewChatAfterStateCheck/);
  assert.doesNotMatch(background, /chrome\.tabs\.create\(/);
  assert.doesNotMatch(background, /chrome\.tabs\.update\(/);
  assert.doesNotMatch(background, /chrome\.tabs\.reload\(/);
  assert.doesNotMatch(background, /ctrl\+t/i);
});

test("UI heartbeat persists page state without MCP", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-chat-wake-ui-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "config", "chat-browser-wake.json"), JSON.stringify({
    version: 1, enabled: true, token: "u".repeat(64), lease_ms: 30000, expected_extension_version: "0.6.6"
  }));
  let now = Date.parse("2026-09-29T09:00:00Z");
  const wake = await new ChatBrowserWake(root, { clock: () => now }).init();

  await wake.claim([], "client-ui", "developer_ai", 950);
  let result = await wake.uiHeartbeat("client-ui", {
    dispatcher_epoch: 950,
    ui_state: "stable",
    conversation_url: "https://chatgpt.com/c/abc-123",
    composer_present: true,
    composer_empty: true,
    switch_safe: true,
    content_busy: false
  });
  assert.equal(result.state, "heartbeat");
  let state = await wake.readState();
  assert.equal(state.dispatcher.ui_state, "stable");
  assert.equal(state.dispatcher.composer_present, true);
  assert.equal(state.dispatcher.switch_safe, true);
  assert.equal(state.dispatcher.conversation_url, "https://chatgpt.com/c/abc-123");
  const stableSince = state.dispatcher.ui_state_since_at_ms;

  now += 15_000;
  await wake.uiHeartbeat("client-ui", {
    dispatcher_epoch: 950,
    ui_state: "generating",
    conversation_url: "https://chatgpt.com/c/abc-123",
    composer_present: true,
    composer_empty: true,
    switch_safe: false,
    content_busy: false
  });
  state = await wake.readState();
  assert.equal(state.dispatcher.ui_state, "generating");
  assert.equal(state.dispatcher.ui_state_since_at_ms, now);
  assert.notEqual(state.dispatcher.ui_state_since_at_ms, stableSince);
  assert.equal(state.dispatcher.last_ui_seen_at_ms, now);
});

test("processing_delayed delegates recovery through the local MCP executor", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const content = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "content.js"), "utf8");
  assert.match(content, /\/mcp-action\?token=/);
  assert.match(content, /requestMcpAction\("stop_and_continue"/);
  assert.match(content, /recovery_status: extra\.recovery_status/);
  assert.doesNotMatch(content, /requestAutomationAction\(/);
  assert.doesNotMatch(content, /\.click\(/);
  assert.doesNotMatch(content, /chrome\.tabs\.reload\(/);
  assert.doesNotMatch(content, /chrome\.runtime\.reload\(\)/);
});

test("UI heartbeat records delayed recovery attempts and results", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-chat-wake-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "config", "chat-browser-wake.json"), JSON.stringify({
    version: 1, enabled: true, token: "r".repeat(64), lease_ms: 30000, expected_extension_version: "0.6.8"
  }));
  let now = Date.parse("2026-09-29T11:00:00Z");
  const wake = await new ChatBrowserWake(root, { clock: () => now }).init();
  await wake.claim([], "client-recovery", "developer_ai", 1200);

  await wake.uiHeartbeat("client-recovery", {
    dispatcher_epoch: 1200,
    ui_state: "processing_delayed",
    conversation_url: "https://chatgpt.com/c/recovery-1",
    composer_present: true,
    recovery_action: "stop_and_continue",
    recovery_status: "started",
    recovery_attempt: 1
  });
  now += 4000;
  await wake.uiHeartbeat("client-recovery", {
    dispatcher_epoch: 1200,
    ui_state: "generating",
    conversation_url: "https://chatgpt.com/c/recovery-1",
    composer_present: true,
    recovery_action: "stop_and_continue",
    recovery_status: "succeeded",
    recovery_attempt: 1
  });

  const state = await wake.readState();
  assert.equal(state.dispatcher.recovery.action, "stop_and_continue");
  assert.equal(state.dispatcher.recovery.status, "succeeded");
  assert.equal(state.dispatcher.recovery.attempt, 1);
  assert.equal(state.recovery_events.length, 2);
  assert.deepEqual(state.recovery_events.map(x => x.status), ["started", "succeeded"]);
});

test("generation state reuses the same stop button detector", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const content = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "content.js"), "utf8");
  assert.match(content, /if \(stopButton\(\)\) return \{ state: "generating", detail: null \};/);
  assert.match(content, /stop generating\|停止生成\|停止响应\|停止/);
});


test("real processing banner in the active assistant turn is detected without aria-live", async () => {
  const banner = "我们的系统正在进一步处理此请求，处理完毕后将给出回复。";
  const state = await readContentScriptUiStateFixture({
    bannerText: banner,
    bannerClass: "text-token-text-secondary"
  });
  assert.equal(state.ui_state, "processing_delayed");
  assert.equal(state.switch_safe, false);
  assert.equal(state.content_busy, false);
});

test("normal assistant text mentioning the delayed phrase is not treated as a status banner", async () => {
  const banner = "我们的系统正在进一步处理此请求，处理完毕后将给出回复。";
  const state = await readContentScriptUiStateFixture({ bannerText: banner, bannerClass: "" });
  assert.equal(state.ui_state, "generating");
  assert.equal(state.switch_safe, false);
});

test("top-level ChatGPT stream recovery polling timeout is detected as execution_error", async () => {
  const state = await readContentScriptUiStateFixture({
    bannerText: "",
    systemErrorText: "ChatGPT stream recovery polling timed out"
  });
  assert.equal(state.ui_state, "execution_error");
  assert.equal(state.switch_safe, false);
});

test("same stream recovery timeout text inside a user message is not treated as a system error", async () => {
  const state = await readContentScriptUiStateFixture({
    bannerText: "",
    userMessageText: "ChatGPT stream recovery polling timed out"
  });
  assert.notEqual(state.ui_state, "execution_error");
});

test("outdated content script reports a warning without self reload and does not register dispatcher", async () => {
  const state = await readContentScriptUiStateFixture({
    bannerText: "",
    extensionVersion: "0.6.12",
    latestExtensionVersion: "0.6.14",
    compatible: false
  });
  assert.ok(state.sentMessages.some(message =>
    message.type === "WYERP_EXTENSION_OUTDATED" &&
    message.current_version === "0.6.12" &&
    message.latest_version === "0.6.14"
  ));
  assert.equal(state.sentMessages.some(message => message.type === "WYERP_REGISTER_DISPATCHER"), false);
});

test("background holds an outdated extension and never auto reloads or refreshes ChatGPT", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const background = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "background.js"), "utf8");
  assert.match(background, /WYERP_EXTENSION_OUTDATED/);
  assert.match(background, /hold_for_manual_extension_reload/);
  assert.match(background, /wyerpExtensionWarning/);
  assert.match(background, /chrome\.scripting\.executeScript/);
  assert.match(background, /bootstrapExistingChatTabs/);
  assert.doesNotMatch(background, /chrome\.runtime\.reload\(\)/);
  assert.doesNotMatch(background, /chrome\.tabs\.reload\(/);
  assert.doesNotMatch(background, /chrome\.tabs\.create/);
});

test("background requires a versioned content runtime and reinjects instead of trusting a stale responder", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const background = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "background.js"), "utf8");
  const content = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "content.js"), "utf8");
  assert.match(background, /WYERP_READ_CHAT_STATE_V2/);
  assert.match(background, /state\.extension_version \|\| ""\) === EXTENSION_VERSION/);
  assert.match(background, /WYERP_RETIRE_STALE_CONTENT/);
  assert.match(background, /content_script_version_mismatch/);
  assert.match(background, /chrome\.scripting\.executeScript/);
  assert.match(content, /extension_version: extensionVersion/);
  assert.match(content, /WYERP_RETIRE_STALE_CONTENT/);
  assert.match(content, /deactivateDispatcher\(\)/);
});

test("versioned content probe is affirmative and retired stale content stops answering probes", async () => {
  const state = await readContentScriptUiStateFixture({
    bannerText: "",
    extensionVersion: "0.6.30",
    latestExtensionVersion: "0.6.30",
    compatible: true
  });
  assert.equal(state.v2?.ok, true);
  assert.equal(state.v2?.extension_version, "0.6.30");
  const retired = state.dispatchMessage({
    type: "WYERP_RETIRE_STALE_CONTENT",
    expected_extension_version: "0.6.31"
  });
  assert.equal(retired?.ok, true);
  assert.equal(retired?.retired, true);
  assert.equal(retired?.extension_version, "0.6.30");
  assert.equal(state.dispatchMessage({ type: "WYERP_READ_CHAT_STATE_V2" }), undefined);
});

test("execution-error handling delegates mutations to the local MCP executor", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const content = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "content.js"), "utf8");
  assert.match(content, /\/mcp-action\?token=/);
  assert.match(content, /requestMcpAction\("retry_or_continue"/);
  assert.doesNotMatch(content, /requestAutomationAction\(/);
  assert.doesNotMatch(content, /\.click\(/);
});

test("Chat Wake never mutates GPT directly and delegates through the local MCP executor", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const background = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "background.js"), "utf8");
  const content = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "content.js"), "utf8");
  for (const source of [background, content]) {
    assert.match(source, /\/mcp-action\?token=/);
    assert.doesNotMatch(source, /\.click\(/);
    assert.doesNotMatch(source, /chrome\.tabs\.update\(/);
    assert.doesNotMatch(source, /chrome\.tabs\.reload\(/);
    assert.doesNotMatch(source, /chrome\.runtime\.reload\(/);
  }
  assert.doesNotMatch(content, /setComposer\(/);
  assert.doesNotMatch(content, /clearComposer\(/);
  assert.doesNotMatch(content, /new InputEvent\(/);
});

test("monitor-only extension never initiates execution-error recovery", async () => {
  const result = await runExecutionErrorRecoveryFixture({ allowAutomation: false });
  const recovery = result.heartbeats.filter(item => item.recovery_action === "retry_or_continue");
  assert.equal(result.mcpActions.length, 0);
  assert.equal(recovery.length, 0);
});

test("execution-error episode survives transient generating state and only resets after sustained stable state", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const content = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "content.js"), "utf8");
  assert.match(content, /const ERROR_RECOVERY_STABLE_RESET_MS = 10000/);
  assert.match(content, /let errorRecoveryStableSince = null/);
  assert.match(content, /if \(state\.ui_state === "stable"\)/);
  assert.match(content, /Date\.now\(\) - errorRecoveryStableSince >= ERROR_RECOVERY_STABLE_RESET_MS/);
  assert.doesNotMatch(content, /state\.ui_state === "stable" \|\| state\.ui_state === "generating"\) resetErrorRecoveryEpisode\(\)/);
  assert.match(content, /if \(Date\.now\(\) < errorRecoveryNextGatePollAt\) return/);
});

test("UI heartbeat persists retry_or_continue recovery events", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-chat-wake-error-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "config", "chat-browser-wake.json"), JSON.stringify({
    version: 1, enabled: true, token: "e".repeat(64), lease_ms: 30000, expected_extension_version: "0.6.15"
  }));
  let now = Date.parse("2026-09-29T14:00:00Z");
  const wake = await new ChatBrowserWake(root, { clock: () => now }).init();
  await wake.claim([], "client-error-recovery", "developer_ai", 1600);
  await wake.uiHeartbeat("client-error-recovery", {
    dispatcher_epoch: 1600,
    ui_state: "execution_error",
    conversation_url: "https://chatgpt.com/c/error-recovery",
    composer_present: true,
    recovery_action: "retry_or_continue",
    recovery_status: "started",
    recovery_attempt: 1
  });
  now += 3000;
  await wake.uiHeartbeat("client-error-recovery", {
    dispatcher_epoch: 1600,
    ui_state: "generating",
    conversation_url: "https://chatgpt.com/c/error-recovery",
    composer_present: true,
    recovery_action: "retry_or_continue",
    recovery_status: "succeeded",
    recovery_attempt: 1
  });
  const state = await wake.readState();
  assert.equal(state.dispatcher.recovery.action, "retry_or_continue");
  assert.equal(state.dispatcher.recovery.status, "succeeded");
  assert.deepEqual(state.recovery_events.slice(-2).map(x => x.action), ["retry_or_continue", "retry_or_continue"]);
});

test("service worker restart restores the same active candidate checkpoint and resumes after error", async () => {
  const storage = {};
  const first = await createBackgroundCheckpointHarness(storage);
  assert.equal((await first.dispatch({ type: "WYERP_REGISTER_DISPATCHER" })).dispatcher, true);
  const candidate = {
    eligible: true,
    project_id: "wyerp-taskboard",
    task_id: "WTB-WAKE-001",
    detection_id: "det_checkpoint",
    eligible_role: "developer_ai",
    expires_at: "2099-01-01T00:00:00.000Z"
  };
  await first.dispatch({
    type: "WYERP_ROUTE_ROLE_CHAT",
    candidate,
    lease_client_id: "checkpoint-client",
    execution_settings: { max_requests_per_chat: 20, context_warning_at: 15 }
  });
  await first.dispatch({ type: "WYERP_ROLE_CANDIDATE_STARTED", detection_id: "det_checkpoint" });
  assert.equal(storage.wyerpExecutionCheckpoints["7"].candidate.detection_id, "det_checkpoint");
  assert.equal(storage.wyerpExecutionCheckpoints["7"].delivered, true);

  const restarted = await createBackgroundCheckpointHarness(storage);
  assert.equal((await restarted.dispatch({ type: "WYERP_REGISTER_DISPATCHER" })).dispatcher, true);
  const blocked = await restarted.dispatch({
    type: "WYERP_GLOBAL_EXECUTION_BLOCKED",
    reason: "execution_error_recovery_exhausted",
    conversation_url: "https://chatgpt.com/c/checkpoint"
  });
  assert.equal(blocked.action, "resume_checkpoint");
  const checkpoint = storage.wyerpExecutionCheckpoints["7"];
  assert.equal(checkpoint.candidate.task_id, "WTB-WAKE-001");
  assert.equal(checkpoint.candidate.detection_id, "det_checkpoint");
  assert.equal(checkpoint.recovery_after_timeout, true);
  assert.equal(checkpoint.delivered, false);
  assert.equal(checkpoint.last_error, "execution_error_recovery_exhausted");
});
