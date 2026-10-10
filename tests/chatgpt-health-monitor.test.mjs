import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatgptHealthMonitor } from "../server/chatgpt-health-monitor.mjs";

async function rootFixture(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-chatgpt-health-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.mkdir(path.join(root, "browser-extension", "chat-wake"), { recursive: true });
  await fs.mkdir(path.join(root, "data", "runtime", "task-scan"), { recursive: true });
  await fs.writeFile(path.join(root, "config", "chatgpt-health.json"), JSON.stringify({
    version: 1,
    enabled: true,
    interval_minutes: 1,
    dispatcher_stale_seconds: 90,
    ui_heartbeat_stale_seconds: 45,
    generating_stale_seconds: 600,
    abnormal_ui_seconds: 30,
    composer_missing_seconds: 60,
    candidate_stall_seconds: 90,
    candidate_ack_stall_seconds: 60,
    ...config
  }));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "test-version" }));
  await fs.writeFile(path.join(root, "browser-extension", "chat-wake", "manifest.json"), JSON.stringify({ version: "test-version" }));
  await fs.writeFile(path.join(root, "data", "runtime", "task-scan", "candidates.json"), JSON.stringify({
    version: 1, candidates: {}
  }));
  return root;
}

function wakeFixture(now, dispatcherPatch = {}, statePatch = {}, configPatch = {}) {
  return async () => ({
    config: { enabled: true, expected_extension_version: "test-version", ...configPatch },
    readState: async () => ({
      version: 1,
      leases: {},
      acked: {},
      dispatcher: {
        client_id: "browser",
        dispatcher_epoch: 900,
        extension_version: "test-version",
        last_seen_at: new Date(now - 10_000).toISOString(),
        last_seen_at_ms: now - 10_000,
        last_ui_seen_at: new Date(now - 5_000).toISOString(),
        last_ui_seen_at_ms: now - 5_000,
        ui_state: "stable",
        ui_state_since_at: new Date(now - 60_000).toISOString(),
        ui_state_since_at_ms: now - 60_000,
        composer_present: true,
        composer_empty: true,
        switch_safe: true,
        content_busy: false,
        ...dispatcherPatch
      },
      ...statePatch
    })
  });
}

function mcpFixture(calls) {
  return async () => {
    calls.push("factory");
    return {
      status: async () => ({
        server: { name: "windows-mcp", version: "4.0.9" },
        protocolVersion: "2025-06-18",
        toolCount: 20
      }),
      callTool: async (name, args, options) => {
        calls.push([name, args, options]);
        return { content: [{ type: "text", text: "Opened Windows:\nChatGPT - Google Chrome" }] };
      }
    };
  };
}

test("healthy minute stays lightweight and does not spawn MCP", async (t) => {
  const root = await rootFixture(t);
  const now = Date.parse("2026-09-29T09:00:00Z");
  const calls = [];
  const monitor = await new ChatgptHealthMonitor(root, {
    clock: () => now,
    mcpClientFactory: mcpFixture(calls),
    wakeFactory: wakeFixture(now),
    chromeProbe: async () => ({ open: true, source: "test" })
  }).init();

  const result = await monitor.check();
  assert.equal(result.healthy, true);
  assert.equal(result.state, "healthy");
  assert.equal(result.mode, "lightweight_only");
  assert.equal(result.mcp.invoked, false);
  assert.equal(result.mcp.required, false);
  assert.deepEqual(calls, []);
  assert.equal(result.lightweight.bridge.ui_state, "stable");
});

test("stale dispatcher escalates to one MCP diagnostic", async (t) => {
  const root = await rootFixture(t);
  const now = Date.parse("2026-09-29T09:00:00Z");
  const calls = [];
  const monitor = await new ChatgptHealthMonitor(root, {
    clock: () => now,
    mcpClientFactory: mcpFixture(calls),
    wakeFactory: wakeFixture(now, {
      last_seen_at: new Date(now - 300_000).toISOString(),
      last_seen_at_ms: now - 300_000,
      last_ui_seen_at: new Date(now - 300_000).toISOString(),
      last_ui_seen_at_ms: now - 300_000
    }),
    chromeProbe: async () => ({ open: true, source: "test" })
  }).init();

  const result = await monitor.check();
  assert.equal(result.healthy, false);
  assert.equal(result.mode, "mcp_diagnostic");
  assert.equal(result.mcp.invoked, true);
  assert.equal(result.mcp.ready, true);
  assert.ok(result.reasons.includes("chatgpt_dispatcher_stale"));
  assert.ok(result.reasons.includes("chatgpt_ui_heartbeat_stale"));
  assert.equal(calls[0], "factory");
  assert.equal(calls[1][0], "Snapshot");
});

test("extension error page text is not mistaken for a ChatGPT visual error", async (t) => {
  const root = await rootFixture(t);
  const now = Date.parse("2026-09-29T09:00:00Z");
  const desktop = [
    "Focused Window:",
    "Name                         Depth  Status",
    "-------------------------  -------  ------",
    "扩展程序 - Google Chrome          1  Normal",
    "UI Tree:",
    "desktop",
    "├── window \"扩展程序 - Google Chrome\"",
    "│   ├── document \"扩展程序\" [value:\"chrome://extensions/?errors=abc\"]",
    "│   ├── text \"ChatGPT extension error\"",
    "│   ├── text \"发生错误\"",
    "│   └── text \"https://chatgpt.com/c/not-a-document-url\"",
    "├── window \"Real Chat - Google Chrome\"",
    "│   ├── document \"Real Chat\" [value:\"https://chatgpt.com/c/real-chat\"]",
    "│   └── text \"ready\""
  ].join("\n");
  const monitor = await new ChatgptHealthMonitor(root, {
    clock: () => now,
    wakeFactory: wakeFixture(now),
    chromeProbe: async () => ({ open: true, source: "test" }),
    mcpClientFactory: async () => ({
      status: async () => ({
        server: { name: "windows-mcp", version: "4.0.9" },
        protocolVersion: "2025-06-18",
        toolCount: 20
      }),
      callTool: async () => ({ content: [{ type: "text", text: JSON.stringify([desktop]) }] })
    })
  }).init();

  const diagnostic = await monitor.diagnoseWithMcp(["periodic_visual_cross_check"]);
  assert.equal(diagnostic.desktop.chatgpt_visible, true);
  assert.equal(diagnostic.desktop.chatgpt_window_name, "Real Chat - Google Chrome");
  assert.equal(diagnostic.desktop.chatgpt_focused, false);
  assert.equal(diagnostic.desktop.error_visible, false);
  assert.equal(diagnostic.desktop.generating_visible, false);
});

test("stale ChatGPT state diagnoses but never refreshes without exhausted browser recovery", async (t) => {
  const root = await rootFixture(t, {
    dispatcher_stale_seconds: 30,
    ui_heartbeat_stale_seconds: 30,
    candidate_stall_seconds: 30,
    auto_recovery_enabled: true,
    auto_recovery_cooldown_seconds: 60,
    auto_recovery_wait_seconds: 1
  });
  const now = Date.parse("2026-09-29T09:00:00Z");
  await fs.writeFile(path.join(root, "data", "runtime", "task-scan", "candidates.json"), JSON.stringify({
    version: 1,
    candidates: {
      det_recover: {
        detection_id: "det_recover",
        eligible: true,
        eligible_role: "test_ai",
        task_id: "TEST-RECOVER",
        first_detected_at: new Date(now - 120_000).toISOString(),
        expires_at: new Date(now + 600_000).toISOString(),
        consumed_at: null,
        stale_at: null
      }
    }
  }));

  const wakeFactory = async () => ({
    config: { enabled: true, expected_extension_version: "test-version" },
    readState: async () => ({
      version: 1,
      leases: {},
      acked: {},
      dispatcher: {
        client_id: "browser",
        dispatcher_epoch: 901,
        extension_version: "test-version",
        last_seen_at: new Date(now - 120_000).toISOString(),
        last_seen_at_ms: now - 120_000,
        last_ui_seen_at: new Date(now - 120_000).toISOString(),
        last_ui_seen_at_ms: now - 120_000,
        ui_state: "stable",
        ui_state_since_at: new Date(now - 1_000).toISOString(),
        ui_state_since_at_ms: now - 1_000,
        composer_present: true,
        composer_empty: true,
        switch_safe: true,
        content_busy: false
      }
    })
  });

  const calls = [];
  const mcpClientFactory = async () => ({
    status: async () => ({
      server: { name: "windows-mcp", version: "4.0.9" },
      protocolVersion: "2025-06-18",
      toolCount: 20
    }),
    callTool: async (name, args, options) => {
      calls.push([name, args, options]);
      if (name === "Snapshot") {
        const desktop = [
          "",
          "Focused Window:",
          "Name                      Depth  Status       Width    Height    Handle",
          "----------------------  -------  ---------  -------  --------  --------",
          "Core Test - Google Chrome       1  Maximized     1920      1080       100",
          "",
          "UI Tree:",
          "desktop",
          "└── window \"Core Test - Google Chrome\"",
          "    └── document \"Core Test\" [value:\"https://chatgpt.com/c/core-test\"]"
        ].join("\n");
        return { content: [{ type: "text", text: JSON.stringify([desktop]) }] };
      }
      return { content: [{ type: "text", text: "ok" }] };
    }
  });
  const rearms = [];
  const monitor = await new ChatgptHealthMonitor(root, {
    clock: () => now,
    mcpClientFactory,
    wakeFactory,
    chromeProbe: async () => ({ open: true, source: "test" }),
    scanStoreFactory: async () => ({
      requestRearm: async (reason, metadata) => {
        rearms.push([reason, metadata]);
        return { rearm_pending: true, scheduler_trigger: { started: true } };
      }
    }),
    sleep: async () => {}
  }).init();

  const result = await monitor.check();
  assert.equal(result.healthy, false);
  assert.equal(result.recovery.attempted, false);
  assert.equal(result.recovery.action, "diagnostic_only_no_refresh");
  assert.ok(result.reasons.includes("chatgpt_dispatcher_stale"));
  assert.ok(result.reasons.includes("chatgpt_ui_heartbeat_stale"));
  assert.equal(calls.some(([name]) => name === "App" || name === "Shortcut"), false);
  assert.equal(rearms.length, 0);
});

test("execution error refresh is last resort only after browser recovery is exhausted", async (t) => {
  const root = await rootFixture(t, {
    auto_recovery_enabled: true,
    auto_recovery_cooldown_seconds: 60,
    auto_recovery_wait_seconds: 1,
    refresh_recovery_evidence_max_age_seconds: 300
  });
  const now = Date.parse("2026-09-29T09:00:00Z");
  let recovered = false;
  const calls = [];
  const wakeFactory = async () => ({
    config: { enabled: true, expected_extension_version: "test-version" },
    readState: async () => ({
      version: 1,
      leases: {},
      acked: {},
      dispatcher: {
        client_id: "browser",
        dispatcher_epoch: 901,
        extension_version: "test-version",
        last_seen_at: new Date(now - 1_000).toISOString(),
        last_seen_at_ms: now - 1_000,
        last_ui_seen_at: new Date(now - 1_000).toISOString(),
        last_ui_seen_at_ms: now - 1_000,
        ui_state: recovered ? "stable" : "execution_error",
        ui_state_since_at: new Date(now - 40_000).toISOString(),
        ui_state_since_at_ms: now - 40_000,
        composer_present: true,
        composer_empty: true,
        switch_safe: recovered,
        content_busy: false,
        recovery: recovered ? null : {
          at: new Date(now - 2_000).toISOString(),
          action: "retry_or_continue",
          status: "exhausted",
          attempt: 3,
          reason: "execution_error_recovery_exhausted",
          conversation_url: "https://chatgpt.com/c/core-test"
        }
      }
    })
  });
  const monitor = await new ChatgptHealthMonitor(root, {
    clock: () => now,
    wakeFactory,
    chromeProbe: async () => ({ open: true, source: "test" }),
    mcpClientFactory: async () => ({
      status: async () => ({
        server: { name: "windows-mcp", version: "4.0.9" },
        protocolVersion: "2025-06-18",
        toolCount: 20
      }),
      callTool: async (name, args, options) => {
        calls.push([name, args, options]);
        if (name === "Snapshot") {
          const desktop = [
            "Focused Window:",
            "Core Test - Google Chrome",
            "UI Tree:",
            "└── window \"Core Test - Google Chrome\"",
            "    └── document \"Core Test\" [value:\"https://chatgpt.com/c/core-test\"]"
          ].join("\n");
          return { content: [{ type: "text", text: JSON.stringify([desktop]) }] };
        }
        return { content: [{ type: "text", text: "ok" }] };
      }
    }),
    chatgptMcpExecutorFactory: async () => ({
      execute: async body => {
        calls.push(["GPT_EXECUTE", body]);
        recovered = true;
        return { ok: true, executed: true, action: body.action };
      }
    }),
    sleep: async () => {}
  }).init();

  const result = await monitor.check();
  assert.equal(result.recovery.attempted, true);
  assert.equal(result.recovery.action, "refresh_existing_chatgpt");
  assert.equal(result.recovery.succeeded, true);
  assert.equal(calls.some(([name]) => name === "App" || name === "Shortcut"), false);
  assert.ok(calls.some(([name, body]) => name === "GPT_EXECUTE" && body.action === "refresh_last_resort" && body.recovery_exhausted === true));
});

test("execution error without exhausted browser recovery never refreshes", async (t) => {
  const root = await rootFixture(t, { auto_recovery_enabled: true });
  const now = Date.parse("2026-09-29T09:00:00Z");
  const calls = [];
  const monitor = await new ChatgptHealthMonitor(root, {
    clock: () => now,
    wakeFactory: wakeFixture(now, {
      ui_state: "execution_error",
      ui_state_since_at: new Date(now - 40_000).toISOString(),
      ui_state_since_at_ms: now - 40_000,
      recovery: {
        at: new Date(now - 2_000).toISOString(),
        action: "retry_or_continue",
        status: "failed",
        attempt: 1,
        reason: "retry_failed"
      }
    }),
    chromeProbe: async () => ({ open: true, source: "test" }),
    mcpClientFactory: mcpFixture(calls)
  }).init();

  const result = await monitor.check();
  assert.equal(result.recovery.attempted, false);
  assert.equal(result.recovery.action, "wait_browser_recovery");
  assert.equal(calls.some(item => Array.isArray(item) && (item[0] === "App" || item[0] === "Shortcut")), false);
});

test("stale heartbeat does not refresh while ChatGPT is visibly generating normally", async (t) => {
  const root = await rootFixture(t, {
    dispatcher_stale_seconds: 30,
    ui_heartbeat_stale_seconds: 30,
    auto_recovery_enabled: true
  });
  const now = Date.parse("2026-09-29T09:00:00Z");
  const calls = [];
  const monitor = await new ChatgptHealthMonitor(root, {
    clock: () => now,
    wakeFactory: wakeFixture(now, {
      last_seen_at: new Date(now - 120_000).toISOString(),
      last_seen_at_ms: now - 120_000,
      last_ui_seen_at: new Date(now - 120_000).toISOString(),
      last_ui_seen_at_ms: now - 120_000
    }),
    chromeProbe: async () => ({ open: true, source: "test" }),
    mcpClientFactory: async () => ({
      status: async () => ({
        server: { name: "windows-mcp", version: "4.0.9" },
        protocolVersion: "2025-06-18",
        toolCount: 20
      }),
      callTool: async (name, args) => {
        calls.push([name, args]);
        if (name === "Snapshot") {
          const desktop = [
            "Focused Window:",
            "Name                      Depth  Status       Width    Height    Handle",
            "----------------------  -------  ---------  -------  --------  --------",
            "Core Test - Google Chrome       1  Maximized     1920      1080       100",
            "UI Tree:",
            "└── window \"Core Test - Google Chrome\"",
            "    ├── document \"Core Test\" [value:\"https://chatgpt.com/c/core-test\"]",
            "    └── text \"处理中\""
          ].join("\n");
          return { content: [{ type: "text", text: JSON.stringify([desktop]) }] };
        }
        return { content: [{ type: "text", text: "ok" }] };
      }
    })
  }).init();
  const result = await monitor.check();
  assert.equal(result.healthy, false);
  assert.equal(result.recovery.action, "diagnostic_only_no_refresh");
  assert.equal(result.recovery.attempted, false);
  assert.equal(calls.some(([name]) => name === "Shortcut"), false);
});

test("ordinary generating state below threshold does not spawn MCP", async (t) => {
  const root = await rootFixture(t);
  const now = Date.parse("2026-09-29T09:00:00Z");
  const calls = [];
  const monitor = await new ChatgptHealthMonitor(root, {
    clock: () => now,
    mcpClientFactory: mcpFixture(calls),
    wakeFactory: wakeFixture(now, {
      ui_state: "generating",
      ui_state_since_at: new Date(now - 120_000).toISOString(),
      ui_state_since_at_ms: now - 120_000,
      switch_safe: false
    }),
    chromeProbe: async () => ({ open: true, source: "test" })
  }).init();

  const result = await monitor.check();
  assert.equal(result.healthy, true);
  assert.equal(result.mcp.invoked, false);
  assert.deepEqual(calls, []);
});

test("generating beyond threshold escalates to MCP", async (t) => {
  const root = await rootFixture(t, { generating_stale_seconds: 300 });
  const now = Date.parse("2026-09-29T09:00:00Z");
  const calls = [];
  const monitor = await new ChatgptHealthMonitor(root, {
    clock: () => now,
    mcpClientFactory: mcpFixture(calls),
    wakeFactory: wakeFixture(now, {
      ui_state: "generating",
      ui_state_since_at: new Date(now - 360_000).toISOString(),
      ui_state_since_at_ms: now - 360_000,
      switch_safe: false
    }),
    chromeProbe: async () => ({ open: true, source: "test" })
  }).init();

  const result = await monitor.check();
  assert.equal(result.healthy, false);
  assert.ok(result.reasons.includes("chatgpt_generating_stalled"));
  assert.equal(result.mcp.invoked, true);
  assert.equal(calls[0], "factory");
});

test("stalled eligible candidate without lease escalates to MCP", async (t) => {
  const root = await rootFixture(t, { candidate_stall_seconds: 30 });
  const now = Date.parse("2026-09-29T09:00:00Z");
  await fs.writeFile(path.join(root, "data", "runtime", "task-scan", "candidates.json"), JSON.stringify({
    version: 1,
    candidates: {
      det_stalled: {
        detection_id: "det_stalled",
        eligible: true,
        eligible_role: "developer_ai",
        task_id: "DEV-STALL",
        first_detected_at: new Date(now - 120_000).toISOString(),
        expires_at: new Date(now + 600_000).toISOString(),
        consumed_at: null,
        stale_at: null
      }
    }
  }));
  const calls = [];
  const monitor = await new ChatgptHealthMonitor(root, {
    clock: () => now,
    mcpClientFactory: mcpFixture(calls),
    wakeFactory: wakeFixture(now),
    chromeProbe: async () => ({ open: true, source: "test" })
  }).init();

  const result = await monitor.check();
  assert.ok(result.reasons.includes("candidate_unleased_stalled"));
  assert.equal(result.lightweight.candidates.stalled[0].detection_id, "det_stalled");
  assert.equal(result.mcp.invoked, true);
});

test("anomaly screenshots are persisted only for anomaly diagnostics and expire after 24 hours", async (t) => {
  const root = await rootFixture(t, { save_anomaly_screenshots: true, anomaly_screenshot_retention_hours: 24 });
  const now = Date.parse("2026-09-29T09:00:00Z");
  const screenshotDir = path.join(root, "data", "runtime", "chatgpt-health", "screenshots");
  await fs.mkdir(screenshotDir, { recursive: true });
  const oldFile = path.join(screenshotDir, "old.png");
  await fs.writeFile(oldFile, Buffer.from("old"));
  const oldTime = new Date(now - 25 * 60 * 60 * 1000);
  await fs.utimes(oldFile, oldTime, oldTime);

  const monitor = await new ChatgptHealthMonitor(root, {
    clock: () => now,
    wakeFactory: wakeFixture(now, {
      last_seen_at: new Date(now - 300_000).toISOString(),
      last_seen_at_ms: now - 300_000,
      last_ui_seen_at: new Date(now - 300_000).toISOString(),
      last_ui_seen_at_ms: now - 300_000
    }),
    chromeProbe: async () => ({ open: true, source: "test" }),
    mcpClientFactory: async () => ({
      status: async () => ({ server: { name: "windows-mcp", version: "test" }, protocolVersion: "2025-06-18", toolCount: 20 }),
      callTool: async (name) => {
        if (name === "Snapshot") return { content: [{ type: "text", text: "Opened Windows:\\nChatGPT - Google Chrome" }] };
        if (name === "Screenshot") return { content: [{ type: "image", mimeType: "image/png", data: Buffer.from("fake-image").toString("base64") }] };
        return { content: [{ type: "text", text: "ok" }] };
      }
    })
  }).init();

  const result = await monitor.check();
  assert.equal(result.mcp.screenshot_evidence.saved, true);
  assert.equal(result.mcp.screenshot_evidence.retention_hours, 24);
  assert.equal(result.mcp.screenshot_evidence.bytes, Buffer.byteLength("fake-image"));
  assert.equal(await fs.readFile(path.join(root, result.mcp.screenshot_evidence.path), "utf8"), "fake-image");
  await assert.rejects(() => fs.access(oldFile));
});

test("periodic visual cross-check does not persist a screenshot when there is no anomaly", async (t) => {
  const root = await rootFixture(t, { dual_channel_visual_check: true, save_anomaly_screenshots: true });
  const now = Date.parse("2026-09-29T09:00:00Z");
  const calls = [];
  const monitor = await new ChatgptHealthMonitor(root, {
    clock: () => now,
    wakeFactory: wakeFixture(now),
    chromeProbe: async () => ({ open: true, source: "test" }),
    mcpClientFactory: async () => ({
      status: async () => ({ server: { name: "windows-mcp", version: "test" }, protocolVersion: "2025-06-18", toolCount: 20 }),
      callTool: async (name) => { calls.push(name); return { content: [{ type: "text", text: "Opened Windows:\\nChatGPT - Google Chrome" }] }; }
    })
  }).init();
  const result = await monitor.check();
  assert.equal(result.healthy, true);
  assert.equal(calls.includes("Screenshot"), false);
  assert.equal(result.mcp.screenshot_evidence, undefined);
});

test("schedule scripts keep a separate one-minute hidden lightweight task", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const install = await fs.readFile(path.join(root, "scripts", "install-chatgpt-health-schedule.ps1"), "utf8");
  const hidden = await fs.readFile(path.join(root, "scripts", "run-hidden.vbs"), "utf8");
  assert.match(install, /WyerpTaskboard-ChatGPT-MCP-Health/);
  assert.match(install, /IntervalMinutes = 1/);
  assert.match(install, /wscript\.exe/);
  assert.match(install, /\/\/B \/\/Nologo/);
  assert.match(install, /run-hidden\.vbs/);
  assert.match(install, /chatgpt-health\.mjs/);
  assert.match(install, /"check"/);
  assert.doesNotMatch(install, /powershell\.exe/i);
  assert.doesNotMatch(install, /run-chatgpt-health\.ps1/);
  assert.match(install, /MultipleInstances IgnoreNew/);
  assert.match(hidden, /shell\.Run\(command, 0, True\)/);
  assert.doesNotMatch(install, /WyerpTaskboard-TaskScan/);
});

test("independent software and extension versions do not trigger MCP when each is current", async (t) => {
  const root = await rootFixture(t);
  const now = Date.parse("2026-09-29T12:00:00Z");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "taskboard-latest" }));
  await fs.writeFile(path.join(root, "browser-extension", "chat-wake", "manifest.json"), JSON.stringify({ version: "extension-latest" }));
  const calls = [];
  const monitor = await new ChatgptHealthMonitor(root, {
    clock: () => now,
    mcpClientFactory: mcpFixture(calls),
    wakeFactory: wakeFixture(now, { extension_version: "extension-latest" }, {}, { expected_extension_version: "extension-latest" }),
    chromeProbe: async () => ({ open: true, source: "test" })
  }).init();
  const result = await monitor.check();
  assert.equal(result.lightweight.versions.taskboard_package, "taskboard-latest");
  assert.equal(result.lightweight.versions.extension_manifest, "extension-latest");
  assert.equal(result.lightweight.versions.extension_expected, "extension-latest");
  assert.equal(result.lightweight.versions.extension_runtime, "extension-latest");
  assert.equal(result.lightweight.versions.contract_ok, true);
  assert.equal(result.mcp.invoked, false);
  assert.equal(result.reasons.includes("version_contract_mismatch"), false);
});

test("outdated runtime extension never refreshes ChatGPT and waits for extension reload", async (t) => {
  const root = await rootFixture(t, { auto_recovery_enabled: true });
  const now = Date.parse("2026-09-29T12:00:00Z");
  await fs.writeFile(path.join(root, "browser-extension", "chat-wake", "manifest.json"), JSON.stringify({ version: "extension-latest" }));
  const calls = [];
  const monitor = await new ChatgptHealthMonitor(root, {
    clock: () => now,
    mcpClientFactory: mcpFixture(calls),
    wakeFactory: wakeFixture(now, { extension_version: "extension-old" }, {}, { expected_extension_version: "extension-latest" }),
    chromeProbe: async () => ({ open: true, source: "test" })
  }).init();
  const result = await monitor.check();
  assert.equal(result.healthy, false);
  assert.ok(result.reasons.includes("extension_runtime_outdated"));
  assert.equal(result.reasons.includes("version_contract_mismatch"), false);
  assert.equal(result.recovery.action, "extension_reload_required");
  assert.equal(result.recovery.attempted, false);
  assert.equal(calls.some(item => Array.isArray(item) && item[0] === "Shortcut"), false);
});
