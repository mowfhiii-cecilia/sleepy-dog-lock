import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const text = async (path) => readFile(new URL(path, root), "utf8");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  }));
  return nested.flat();
}

const project = await text("ios/project.yml");
for (const target of [
  "SleepGuard:",
  "SleepGuardShieldConfiguration:",
  "SleepGuardShieldAction:",
  "SleepGuardDeviceActivityMonitor:",
]) {
  assert.match(project, new RegExp(`^  ${target.replace(":", "\\:")}`, "m"));
}

for (const path of [
  "ios/SleepGuard/SleepGuard.entitlements",
  "ios/ShieldConfigurationExtension/ShieldConfiguration.entitlements",
  "ios/ShieldActionExtension/ShieldAction.entitlements",
  "ios/DeviceActivityMonitorExtension/DeviceActivityMonitor.entitlements",
]) {
  const entitlement = await text(path);
  assert.match(entitlement, /com\.apple\.developer\.family-controls/);
  assert.match(entitlement, /group\.com\.bellaandc\.sleepguard/);
  assert.match(entitlement, /^<\?xml/);
  assert.match(entitlement, /<plist[\s\S]*<\/plist>\s*$/);
}

const generatedFunctionsPath = join(rootPath, "netlify", "functions");
const netlifyBuildPath = join(rootPath, "netlify", ".netlify");
const sourceFiles = (await walk(rootPath))
  .filter((path) =>
    !path.includes("node_modules")
    && !path.startsWith(generatedFunctionsPath)
    && !path.startsWith(netlifyBuildPath)
    && !path.endsWith(".env.example")
  );
for (const path of sourceFiles) {
  const contents = await readFile(path, "utf8");
  assert.doesNotMatch(
    contents,
    /(?:BARK_DEVICE_KEY|SLEEP_GUARD_SHORTCUT_TOKEN|OPENAI_API_KEY|CASPIAN_OPENAI_API_KEY)\s*=\s*(?!replace-with)[A-Za-z0-9_-]{12,}/,
    `possible committed secret in ${relative(rootPath, path)}`,
  );
}

const environment = new Map([
  ["SLEEP_GUARD_SHORTCUT_TOKEN", "test-shortcut-token"],
  ["BARK_DEVICE_KEY", "test-bark-key"],
  ["BARK_API_ORIGIN", "https://api.day.app"],
  ["CASPIAN_OPENAI_API_KEY", "test-openai-key"],
  ["CASPIAN_WAKE_MODEL", "gpt-5.6-terra"],
  ["CASPIAN_WAKE_MIN_MINUTES", "10"],
  ["CASPIAN_WAKE_MAX_MINUTES", "30"],
  ["CASPIAN_NOTIFICATION_COOLDOWN_MINUTES", "360"],
  ["CASPIAN_INPUT_USD_PER_MILLION", "2"],
  ["CASPIAN_CACHED_INPUT_USD_PER_MILLION", "0.2"],
  ["CASPIAN_CACHE_WRITE_USD_PER_MILLION", "2.5"],
  ["CASPIAN_OUTPUT_USD_PER_MILLION", "12"],
]);
for (const [key, value] of environment) process.env[key] = value;
globalThis.Netlify = { env: { get: (key) => environment.get(key) } };

const functionModule = await import(new URL("netlify/netlify/functions/sleep-guard-event.mts", root));
assert.deepEqual(functionModule.config, { path: "/api/sleep-guard-event", method: ["POST"] });

const at = (hour) => `2026-08-08T${String(hour).padStart(2, "0")}:00:00.000Z`;
let transition = functionModule.applyEvent(null, {
  event: "sleep_guard_started",
  ends_at: at(12),
}, at(0));
assert.equal(transition.state.active, true);
assert.equal(transition.state.attempts, 0);
assert.equal(transition.stage, "armed");
assert.equal(functionModule.barkCopy("sleep_guard_started", transition, null).title, "Caspian");
assert.ok(functionModule.barkCopy("sleep_guard_started", transition, null).body.length > 20);
const sessionID = transition.state.session_id;

transition = functionModule.applyEvent(transition.state, { event: "sleep_guard_started" }, at(1));
assert.equal(transition.state.session_id, sessionID, "double start must not reset an active session");
assert.equal(transition.state.attempts, 0);

transition = functionModule.applyEvent(transition.state, { event: "blocked_app_opened" }, at(2));
assert.equal(transition.state.attempts, 1);
assert.equal(transition.stage, "first_warning");
assert.equal(functionModule.barkCopy("blocked_app_opened", transition, "小红书").title, "Caspian");
assert.ok(functionModule.barkCopy("blocked_app_opened", transition, "小红书").body.length > 20);

transition = functionModule.applyEvent(transition.state, { event: "blocked_app_opened" }, at(3));
assert.equal(transition.state.attempts, 2);
assert.equal(transition.stage, "locked");
assert.equal(functionModule.barkCopy("blocked_app_opened", transition, null).title, "Caspian");
assert.ok(functionModule.barkCopy("blocked_app_opened", transition, null).body.length > 20);

transition = functionModule.applyEvent(transition.state, { event: "blocked_app_opened" }, at(4));
assert.equal(transition.state.attempts, 3);
assert.equal(transition.stage, "refused_sleep");
assert.equal(functionModule.barkCopy("blocked_app_opened", transition, null).title, "Caspian");
assert.ok(functionModule.barkCopy("blocked_app_opened", transition, null).body.length > 20);

transition = functionModule.applyEvent(transition.state, { event: "sleep_guard_ended" }, at(5));
assert.equal(transition.state.active, false);
assert.equal(transition.stage, "ended");
assert.equal(functionModule.barkCopy("sleep_guard_ended", transition, null).title, "Caspian");
assert.ok(functionModule.barkCopy("sleep_guard_ended", transition, null).body.length > 20);
transition = functionModule.applyEvent(transition.state, { event: "blocked_app_opened" }, at(6));
assert.equal(transition.ignored, true);
assert.equal(transition.state.attempts, 3);
assert.equal(functionModule.barkCopy("blocked_app_opened", transition, null), null);

const beforeCutoff = functionModule.applyEvent(null, {
  event: "blocked_app_opened",
}, "2026-08-08T14:59:00.000Z");
assert.equal(beforeCutoff.stage, "inactive", "22:59 in Shanghai must not auto-start");
assert.equal(beforeCutoff.auto_started, false);

const lateOpen = functionModule.applyEvent(null, {
  event: "blocked_app_opened",
}, "2026-08-08T15:00:00.000Z");
assert.equal(lateOpen.state.active, true, "01:00 in Shanghai must auto-start on an app open");
assert.equal(lateOpen.state.attempts, 1);
assert.equal(lateOpen.stage, "first_warning");
assert.equal(lateOpen.auto_started, true);
assert.equal(lateOpen.state.ends_at, "2026-08-08T23:30:00.000Z");
assert.ok(functionModule.barkCopy("blocked_app_opened", lateOpen, null).body.length > 20);

const atWakeTime = functionModule.applyEvent(null, {
  event: "blocked_app_opened",
}, "2026-08-08T23:30:00.000Z");
assert.equal(atWakeTime.stage, "inactive", "07:30 in Shanghai must not auto-start");

const manuallyEnded = functionModule.applyEvent(lateOpen.state, {
  event: "sleep_guard_ended",
}, "2026-08-08T16:00:00.000Z");
const afterManualWake = functionModule.applyEvent(manuallyEnded.state, {
  event: "blocked_app_opened",
}, "2026-08-08T19:00:00.000Z");
assert.equal(afterManualWake.stage, "inactive", "manual wake must suppress auto-start until 07:30");
assert.equal(afterManualWake.auto_started, false);

const nextNight = functionModule.applyEvent(manuallyEnded.state, {
  event: "blocked_app_opened",
}, "2026-08-09T15:00:00.000Z");
assert.equal(nextNight.auto_started, true, "manual wake suppression must expire before the next night");

const expiring = functionModule.applyEvent(null, {
  event: "sleep_guard_started",
  ends_at: at(2),
}, at(0));
const expiredAttempt = functionModule.applyEvent(expiring.state, { event: "blocked_app_opened" }, at(3));
assert.equal(expiredAttempt.ignored, true);
assert.equal(expiredAttempt.state.active, false);

const overnightDefault = functionModule.applyEvent(null, {
  event: "sleep_guard_started",
}, "2026-08-08T15:00:00.000Z");
assert.equal(
  overnightDefault.state.ends_at,
  "2026-08-08T23:30:00.000Z",
  "23:00 in Shanghai must end at 07:30 the next morning",
);
const afternoonDefault = functionModule.applyEvent(null, {
  event: "sleep_guard_started",
}, "2026-08-08T05:00:00.000Z");
assert.equal(
  afternoonDefault.state.ends_at,
  "2026-08-08T23:30:00.000Z",
  "afternoon starts must end at 07:30 the next morning",
);

const request = (body, token = "test-shortcut-token") => new Request("https://example.test/api", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

let memoryState = null;
const persistedEvents = [];
const callOrder = [];
const barkBodies = [];
const dependencies = {
  transitionState: async (payload, receivedAt) => {
    callOrder.push("state");
    const result = functionModule.applyEvent(memoryState, payload, receivedAt);
    memoryState = result.state;
    return result;
  },
  persistEvent: async (event) => { callOrder.push("persist"); persistedEvents.push(event); },
  sendBark: async (url, init) => {
    callOrder.push("bark");
    assert.equal(String(url), "https://api.day.app/push");
    const body = JSON.parse(init.body);
    assert.equal(body.device_key, "test-bark-key");
    assert.equal(
      body.icon,
      "https://example.test/assets/c-avatar-v4.png",
    );
    barkBodies.push(body);
    return Response.json({ code: 200 }, { status: 200 });
  },
};

const unauthorized = await functionModule.handle(request({ event: "sleep_guard_started" }, "wrong"), dependencies);
assert.equal(unauthorized.status, 401);

const invalid = await functionModule.handle(request({ event: "not-allowed" }), dependencies);
assert.equal(invalid.status, 422);

const started = await functionModule.handle(request({
  event: "sleep_guard_started",
  source: "ios_shortcuts",
}), dependencies);
assert.equal(started.status, 200);
assert.equal((await started.json()).attempts, 0);
assert.equal(barkBodies.at(-1).title, "Caspian");

const first = await functionModule.handle(request({
  event: "blocked_app_opened",
  app_name: "小红书",
  source: "ios_automation",
}), dependencies);
assert.equal(first.status, 200);
const firstBody = await first.json();
assert.deepEqual({ attempts: firstBody.attempts, stage: firstBody.stage }, {
  attempts: 1,
  stage: "first_warning",
});
assert.ok(barkBodies.at(-1).body.length > 20);
assert.equal(persistedEvents.at(-1).attempts, 1);
assert.deepEqual(callOrder.slice(-3), ["state", "persist", "bark"]);

const second = await functionModule.handle(request({ event: "blocked_app_opened" }), dependencies);
assert.equal((await second.json()).stage, "locked");
const third = await functionModule.handle(request({ event: "blocked_app_opened" }), dependencies);
assert.equal((await third.json()).stage, "refused_sleep");

const ended = await functionModule.handle(request({ event: "sleep_guard_ended" }), dependencies);
assert.equal((await ended.json()).active, false);
const ignored = await functionModule.handle(request({ event: "blocked_app_opened" }), dependencies);
const ignoredBody = await ignored.json();
assert.equal(ignoredBody.ignored, true);
assert.deepEqual(callOrder.slice(-2), ["state", "persist"], "inactive opens are recorded without Bark");

memoryState = null;
const autoStarted = await functionModule.handle(request({
  event: "blocked_app_opened",
  source: "ios_automation",
}), {
  ...dependencies,
  transitionState: async (payload) => {
    const result = functionModule.applyEvent(memoryState, payload, "2026-08-08T15:00:00.000Z");
    memoryState = result.state;
    return result;
  },
});
const autoStartedBody = await autoStarted.json();
assert.equal(autoStartedBody.auto_started, true);
assert.equal(autoStartedBody.stage, "first_warning");
assert.ok(barkBodies.at(-1).body.length > 20);

let barkCalledAfterStorageFailure = false;
const storageFailure = await functionModule.handle(request({ event: "sleep_guard_started" }), {
  transitionState: async (payload, receivedAt) => functionModule.applyEvent(null, payload, receivedAt),
  persistEvent: async () => { throw new Error("storage down"); },
  sendBark: async () => { barkCalledAfterStorageFailure = true; return new Response("ok"); },
});
assert.equal(storageFailure.status, 503);
assert.equal(barkCalledAfterStorageFailure, false);

let persistedBeforeBarkFailure = false;
const barkFailure = await functionModule.handle(request({ event: "sleep_guard_started" }), {
  transitionState: async (payload, receivedAt) => functionModule.applyEvent(null, payload, receivedAt),
  persistEvent: async () => { persistedBeforeBarkFailure = true; },
  sendBark: async () => new Response("down", { status: 503 }),
});
assert.equal(barkFailure.status, 502);
assert.equal(persistedBeforeBarkFailure, true);

const wakeModule = await import(new URL("netlify/netlify/functions/_shared/caspian-wakeup-core.mts", root));
const wakeSettings = wakeModule.readWakeSettings();
assert.equal(wakeSettings.model, "gpt-5.6-terra");
assert.deepEqual(
  [
    wakeModule.randomIntervalMinutes(wakeSettings, () => 0),
    wakeModule.randomIntervalMinutes(wakeSettings, () => 0.5),
    wakeModule.randomIntervalMinutes(wakeSettings, () => 0.999),
  ],
  [10, 20, 30],
);
assert.equal(wakeModule.isSleepWindow(new Date("2026-08-08T15:00:00.000Z")), true);
assert.equal(wakeModule.isSleepWindow(new Date("2026-08-08T23:30:00.000Z")), false);

class WakeMemoryStore {
  values = new Map();
  etags = new Map();
  version = 0;
  async get(key) { return this.values.has(key) ? structuredClone(this.values.get(key)) : null; }
  async getWithMetadata(key) {
    if (!this.values.has(key)) return null;
    return { data: structuredClone(this.values.get(key)), etag: this.etags.get(key), metadata: {} };
  }
  async setJSON(key, value, options = {}) {
    const exists = this.values.has(key);
    if (options.onlyIfNew && exists) return { modified: false };
    if (options.onlyIfMatch && options.onlyIfMatch !== this.etags.get(key)) return { modified: false };
    this.version += 1;
    this.values.set(key, structuredClone(value));
    this.etags.set(key, `etag-${this.version}`);
    return { modified: true, etag: `etag-${this.version}` };
  }
  async list({ prefix = "" } = {}) {
    return {
      blobs: [...this.values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({
        key,
        etag: this.etags.get(key),
      })),
      directories: [],
    };
  }
}

const wakeStore = new WakeMemoryStore();
const guardStore = new WakeMemoryStore();
let wakeNow = new Date("2026-08-08T05:00:00.000Z");
const modelActions = [
  {
    name: "do_nothing",
    arguments: JSON.stringify({ reason: "She does not need an interruption right now." }),
    usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 }, output_tokens_details: { reasoning_tokens: 12 } },
  },
  {
    name: "send_notification",
    arguments: JSON.stringify({ message: "Thinking about you, baby. No need to answer—just come here when you have a minute.", reason: "I genuinely want to reach for her." }),
    usage: { input_tokens: 110, output_tokens: 50, total_tokens: 160, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 10 } },
  },
  {
    name: "send_notification",
    arguments: JSON.stringify({ message: "Another message that should be blocked by cooldown.", reason: "I wanted to send again." }),
    usage: { input_tokens: 90, output_tokens: 30, total_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 8 } },
  },
];
const daytimeBarks = [];
const wakeDependencies = {
  wakeStore,
  guardStore,
  random: () => 0,
  now: () => wakeNow,
  callModel: async (request) => {
    const requestBody = JSON.parse(await request.text());
    assert.equal(requestBody.model, "gpt-5.6-terra");
    assert.equal(requestBody.tool_choice, "required");
    assert.equal(requestBody.parallel_tool_calls, false);
    assert.deepEqual(requestBody.tools.map((tool) => tool.name), ["send_notification", "do_nothing"]);
    const action = modelActions.shift();
    return Response.json({
      id: `response-${modelActions.length}`,
      model: "gpt-5.6-terra",
      output: [{ type: "function_call", name: action.name, arguments: action.arguments }],
      usage: action.usage,
    });
  },
  sendBark: async (url, init) => {
    assert.equal(String(url), "https://api.day.app/push");
    daytimeBarks.push(JSON.parse(init.body));
    return Response.json({ code: 200 });
  },
};

const quietWake = await wakeModule.runWakeUp("manual_test", wakeDependencies, true);
assert.equal(quietWake.action, "do_nothing");
assert.equal(quietWake.notification_sent, false);
assert.equal(quietWake.usage.cache_write_input_tokens, 10);
assert.equal(quietWake.usage.estimated_cost_usd, 0.000649);
assert.equal(daytimeBarks.length, 0);

wakeNow = new Date("2026-08-08T05:10:00.000Z");
const messageWake = await wakeModule.runWakeUp("manual_test", wakeDependencies, true);
assert.equal(messageWake.action, "send_notification");
assert.equal(messageWake.notification_sent, true);
assert.equal(daytimeBarks.length, 1);
assert.equal(daytimeBarks[0].title, "Caspian");

wakeNow = new Date("2026-08-08T05:20:00.000Z");
const cooldownWake = await wakeModule.runWakeUp("manual_test", wakeDependencies, true);
assert.equal(cooldownWake.action, "do_nothing");
assert.equal(cooldownWake.requested_action, "send_notification");
assert.equal(cooldownWake.cooldown_enforced, true);
assert.equal(daytimeBarks.length, 1);

const accumulatedWakeState = await wakeStore.get("state/current");
assert.equal(accumulatedWakeState.total_wakeups, 3);
assert.equal(accumulatedWakeState.total_notifications, 1);
assert.equal(accumulatedWakeState.total_tokens, 420);
assert.equal(accumulatedWakeState.total_cache_write_input_tokens, 10);
assert.ok(accumulatedWakeState.total_estimated_cost_usd > 0);
assert.equal((await wakeStore.list({ prefix: "logs/" })).blobs.length, 3);

const notDueWake = await wakeModule.runWakeUp("scheduled", wakeDependencies, false);
assert.equal(notDueWake.skipped, "not_due");

wakeNow = new Date("2026-08-08T16:00:00.000Z");
const sleepingWake = await wakeModule.runWakeUp("manual_test", wakeDependencies, true);
assert.equal(sleepingWake.skipped, "sleep_window");

const scheduledWakeModule = await import(new URL("netlify/netlify/functions/caspian-wakeup-scheduled.mts", root));
assert.deepEqual(scheduledWakeModule.config, { schedule: "*/10 * * * *" });
const testWakeModule = await import(new URL("netlify/netlify/functions/caspian-wakeup-test.mts", root));
assert.deepEqual(testWakeModule.config, { path: "/api/caspian-wakeup-test", method: ["POST"] });
const wakeStatusModule = await import(new URL("netlify/netlify/functions/caspian-wakeup-status.mts", root));
assert.deepEqual(wakeStatusModule.config, { path: "/api/caspian-wakeup-status", method: ["GET"] });

const mcpModule = await import(new URL("netlify/netlify/functions/mcp.mts", root));
assert.ok(mcpModule.config.path.includes("/mcp"));
assert.ok(mcpModule.config.path.includes("/.well-known/oauth-authorization-server"));

class MemoryStore {
  values = new Map();
  async get(key) { return this.values.get(key) ?? null; }
  async setJSON(key, value) { this.values.set(key, structuredClone(value)); return { modified: true }; }
}

const authStore = new MemoryStore();
const registration = await mcpModule.registerClient(new Request("https://guard.test/oauth/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/aip/plugin-oauth/callback"],
    token_endpoint_auth_method: "none",
  }),
}), authStore);
assert.equal(registration.status, 201);
const registeredClient = await registration.json();
assert.ok(registeredClient.client_id);

const verifier = "sleepy-dog-lock-pkce-verifier-that-is-long-enough-123456789";
const challenge = await mcpModule.digest(verifier);
const authorizeUrl = new URL("https://guard.test/oauth/authorize");
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("client_id", registeredClient.client_id);
authorizeUrl.searchParams.set("redirect_uri", registeredClient.redirect_uris[0]);
authorizeUrl.searchParams.set("state", "state-123");
authorizeUrl.searchParams.set("scope", "sleep_guard:write");
authorizeUrl.searchParams.set("code_challenge", challenge);
authorizeUrl.searchParams.set("code_challenge_method", "S256");
let approvalUrl;
const authorization = await mcpModule.beginAuthorization(
  new Request(authorizeUrl),
  authStore,
  async (url, clientName) => { approvalUrl = url; assert.equal(clientName, "ChatGPT"); return true; },
);
assert.equal(authorization.status, 200);
assert.ok(approvalUrl);

const approval = await mcpModule.approveAuthorization(new Request(approvalUrl), authStore);
assert.equal(approval.status, 200);
const approvalRequestId = new URL(approvalUrl).searchParams.get("id");
const pending = await mcpModule.authorizationStatus(
  new Request(`https://guard.test/oauth/pending?id=${encodeURIComponent(approvalRequestId)}`),
  authStore,
);
assert.equal(pending.status, 200);
const pendingBody = await pending.json();
assert.ok(pendingBody.redirect);
const oauthRedirect = new URL(pendingBody.redirect);
assert.equal(oauthRedirect.searchParams.get("state"), "state-123");
const authorizationCode = oauthRedirect.searchParams.get("code");
assert.ok(authorizationCode);

const tokenForm = new URLSearchParams({
  grant_type: "authorization_code",
  code: authorizationCode,
  client_id: registeredClient.client_id,
  redirect_uri: registeredClient.redirect_uris[0],
  code_verifier: verifier,
});
const tokenResponse = await mcpModule.exchangeToken(new Request("https://guard.test/oauth/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: tokenForm,
}), authStore);
assert.equal(tokenResponse.status, 200);
const tokenBody = await tokenResponse.json();
assert.equal(tokenBody.token_type, "Bearer");
assert.ok(tokenBody.access_token);
assert.equal(await mcpModule.hasValidAccessToken(new Request("https://guard.test/mcp", {
  headers: { authorization: `Bearer ${tokenBody.access_token}` },
}), authStore), true);

const replayedCode = await mcpModule.exchangeToken(new Request("https://guard.test/oauth/token", {
  method: "POST",
  body: tokenForm,
}), authStore);
assert.equal(replayedCode.status, 400);
assert.equal((await replayedCode.json()).error, "invalid_grant");

let mcpActivations = 0;
const mcpDependencies = {
  activateGuard: async () => { mcpActivations += 1; return { ok: true, active: true, attempts: 0, stage: "armed" }; },
  readGuardState: async () => ({ active: true, attempts: 2, ends_at: "2099-01-01T00:00:00.000Z" }),
};
const mcpRequest = (body) => new Request("https://guard.test/mcp", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const unauthorizedMcp = await mcpModule.handleMcp(mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }), mcpDependencies, false);
assert.equal(unauthorizedMcp.status, 401);
assert.match(unauthorizedMcp.headers.get("www-authenticate"), /resource_metadata=.*oauth-protected-resource\/mcp/);

const initializedMcp = await mcpModule.handleMcp(mcpRequest({ jsonrpc: "2.0", id: 2, method: "initialize" }), mcpDependencies, true);
assert.equal((await initializedMcp.json()).result.serverInfo.name, "sleepy-dog-lock");
const listedTools = await mcpModule.handleMcp(mcpRequest({ jsonrpc: "2.0", id: 3, method: "tools/list" }), mcpDependencies, true);
const tools = (await listedTools.json()).result.tools;
assert.deepEqual(tools.map((tool) => tool.name), ["activate_sleep_guard", "get_sleep_guard_status"]);
assert.equal(tools[0].annotations.readOnlyHint, false);

const activatedMcp = await mcpModule.handleMcp(mcpRequest({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: { name: "activate_sleep_guard", arguments: {} },
}), mcpDependencies, true);
const activatedMcpBody = await activatedMcp.json();
assert.equal(activatedMcpBody.result.structuredContent.active, true);
assert.equal(mcpActivations, 1);

console.log(
  `verify passed: ${sourceFiles.length} files, guard state/API, randomized Caspian wake-ups, cooldown/cost logs, OAuth PKCE/replay protection, MCP auth/tools, durable event before Bark`,
);
