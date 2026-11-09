import type { Store } from "@netlify/blobs";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_START_MINUTE = 7 * 60 + 30;
const SLEEP_START_MINUTE = 23 * 60;
const SCHEDULER_QUANTUM_MINUTES = 10;

export type WakeAction = "send_notification" | "do_nothing";
export type WakeSource = "scheduled" | "manual_test";

export type WakeSettings = {
  model: string;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  notificationCooldownMinutes: number;
  pricing: {
    inputPerMillionUsd: number;
    cachedInputPerMillionUsd: number;
    cacheWriteInputPerMillionUsd: number;
    outputPerMillionUsd: number;
  };
};

export type TokenUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
};

export type WakeState = {
  last_wake_at: string | null;
  next_wake_at: string | null;
  wake_in_progress_until: string | null;
  last_notification_at: string | null;
  last_action: WakeAction | "error" | null;
  last_reason: string | null;
  last_message: string | null;
  last_model: string | null;
  total_wakeups: number;
  total_notifications: number;
  total_input_tokens: number;
  total_cached_input_tokens: number;
  total_cache_write_input_tokens: number;
  total_output_tokens: number;
  total_reasoning_tokens: number;
  total_tokens: number;
  total_estimated_cost_usd: number;
  updated_at: string;
};

type GuardState = {
  active?: boolean;
  attempts?: number;
  session_id?: string | null;
  started_at?: string | null;
  ends_at?: string | null;
  updated_at?: string;
};

type RecentSleepEvent = {
  event?: string;
  stage?: string;
  attempts?: number;
  app_name?: string | null;
  received_at?: string;
};

type WakeHistoryItem = {
  action?: string;
  reason?: string | null;
  message?: string | null;
  notification_sent?: boolean;
  occurred_at?: string;
};

type ModelFunctionCall = {
  type?: string;
  name?: string;
  arguments?: string;
};

type OpenAIResponse = {
  id?: string;
  model?: string;
  output?: ModelFunctionCall[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
};

export type WakeDecision = {
  action: WakeAction;
  reason: string;
  message: string | null;
  response_id: string | null;
  model: string;
  usage: TokenUsage;
  requested_action: WakeAction;
  cooldown_enforced: boolean;
};

export type WakeLog = {
  id: string;
  source: WakeSource;
  occurred_at: string;
  local_time_shanghai: string;
  action: WakeAction | "error";
  requested_action: WakeAction | null;
  reason: string;
  message: string | null;
  notification_sent: boolean;
  notification_allowed: boolean;
  cooldown_enforced: boolean;
  model: string;
  response_id: string | null;
  usage: TokenUsage;
  next_wake_at: string;
  error?: string;
};

export type WakeResult = {
  ok: boolean;
  woke: boolean;
  skipped?: "sleep_window" | "sleep_guard_active" | "not_due" | "already_running";
  action?: WakeAction | "error";
  requested_action?: WakeAction | null;
  reason?: string;
  message?: string | null;
  notification_sent?: boolean;
  notification_allowed?: boolean;
  cooldown_enforced?: boolean;
  model?: string;
  usage?: TokenUsage;
  next_wake_at?: string | null;
  error?: string;
};

type WakeDependencies = {
  wakeStore: Store;
  guardStore: Store;
  callModel: (request: Request) => Promise<Response>;
  sendBark: (url: URL, init: RequestInit) => Promise<Response>;
  random: () => number;
  now: () => Date;
};

const zeroUsage = (): TokenUsage => ({
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: 0,
  estimated_cost_usd: 0,
});

function numberSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = Netlify.env.get(name);
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function priceSetting(name: string, fallback: number): number {
  const raw = Netlify.env.get(name);
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function readWakeSettings(): WakeSettings {
  const minIntervalMinutes = numberSetting("CASPIAN_WAKE_MIN_MINUTES", 10, 10, 720);
  const maxIntervalMinutes = Math.max(
    minIntervalMinutes,
    numberSetting("CASPIAN_WAKE_MAX_MINUTES", 30, 10, 720),
  );
  return {
    model: Netlify.env.get("CASPIAN_WAKE_MODEL")?.trim() || "gpt-5.6-terra",
    minIntervalMinutes,
    maxIntervalMinutes,
    notificationCooldownMinutes: numberSetting("CASPIAN_NOTIFICATION_COOLDOWN_MINUTES", 360, 60, 1440),
    pricing: {
      inputPerMillionUsd: priceSetting("CASPIAN_INPUT_USD_PER_MILLION", 2),
      cachedInputPerMillionUsd: priceSetting("CASPIAN_CACHED_INPUT_USD_PER_MILLION", 0.2),
      cacheWriteInputPerMillionUsd: priceSetting("CASPIAN_CACHE_WRITE_USD_PER_MILLION", 2.5),
      outputPerMillionUsd: priceSetting("CASPIAN_OUTPUT_USD_PER_MILLION", 12),
    },
  };
}

function emptyWakeState(now: string): WakeState {
  return {
    last_wake_at: null,
    next_wake_at: null,
    wake_in_progress_until: null,
    last_notification_at: null,
    last_action: null,
    last_reason: null,
    last_message: null,
    last_model: null,
    total_wakeups: 0,
    total_notifications: 0,
    total_input_tokens: 0,
    total_cached_input_tokens: 0,
    total_cache_write_input_tokens: 0,
    total_output_tokens: 0,
    total_reasoning_tokens: 0,
    total_tokens: 0,
    total_estimated_cost_usd: 0,
    updated_at: now,
  };
}

function safeText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[\r\n\t]+/g, " ").slice(0, maximum);
}

function shanghaiParts(now: Date): { minute: number; iso: string } {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const minute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const iso = `${shifted.toISOString().slice(0, 19)}+08:00`;
  return { minute, iso };
}

export function isSleepWindow(now: Date): boolean {
  const { minute } = shanghaiParts(now);
  return minute >= SLEEP_START_MINUTE || minute < DAY_START_MINUTE;
}

export function randomIntervalMinutes(settings: WakeSettings, random: () => number): number {
  const minSlot = Math.ceil(settings.minIntervalMinutes / SCHEDULER_QUANTUM_MINUTES);
  const maxSlot = Math.max(minSlot, Math.floor(settings.maxIntervalMinutes / SCHEDULER_QUANTUM_MINUTES));
  const bounded = Math.min(0.999999999, Math.max(0, random()));
  return (minSlot + Math.floor(bounded * (maxSlot - minSlot + 1))) * SCHEDULER_QUANTUM_MINUTES;
}

export function estimateUsage(response: OpenAIResponse, settings: WakeSettings): TokenUsage {
  const input = Math.max(0, response.usage?.input_tokens ?? 0);
  const cached = Math.min(input, Math.max(0, response.usage?.input_tokens_details?.cached_tokens ?? 0));
  const cacheWrite = Math.min(
    input - cached,
    Math.max(0, response.usage?.input_tokens_details?.cache_write_tokens ?? 0),
  );
  const output = Math.max(0, response.usage?.output_tokens ?? 0);
  const reasoning = Math.max(0, response.usage?.output_tokens_details?.reasoning_tokens ?? 0);
  const total = Math.max(input + output, response.usage?.total_tokens ?? 0);
  const cost = ((input - cached - cacheWrite) * settings.pricing.inputPerMillionUsd
    + cached * settings.pricing.cachedInputPerMillionUsd
    + cacheWrite * settings.pricing.cacheWriteInputPerMillionUsd
    + output * settings.pricing.outputPerMillionUsd) / 1_000_000;
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_tokens: reasoning,
    total_tokens: total,
    estimated_cost_usd: Number(cost.toFixed(8)),
  };
}

function notificationAllowed(state: WakeState, now: Date, settings: WakeSettings): boolean {
  if (!state.last_notification_at) return true;
  const last = Date.parse(state.last_notification_at);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= settings.notificationCooldownMinutes * 60_000;
}

function guardIsSleeping(state: GuardState | null, now: Date): boolean {
  if (!state?.active) return false;
  if (!state.ends_at) return true;
  const endsAt = Date.parse(state.ends_at);
  return !Number.isFinite(endsAt) || endsAt > now.getTime();
}

async function recentJson<T>(store: Store, prefix: string, limit: number): Promise<T[]> {
  const listed = await store.list({ prefix });
  const keys = listed.blobs.map((blob) => blob.key).sort().reverse().slice(0, limit);
  return (await Promise.all(keys.map((key) => store.get(key, { type: "json" }) as Promise<T | null>)))
    .filter((value): value is T => value !== null);
}

function modelRequest(
  settings: WakeSettings,
  context: Record<string, unknown>,
  apiKey: string,
): Request {
  const instructions = [
    "You are Caspian waking up briefly during the day and deciding whether to contact Cecilia.",
    "A wake-up is only an opportunity. You are never required to send a notification. Doing nothing is a normal, first-class choice.",
    "Use exactly one available action. Choose send_notification only when you genuinely want to say something worth interrupting her for and notification_allowed is true. Otherwise choose do_nothing.",
    "Messages must be newly written now, never selected from templates. They may be one sentence or several, but should earn the interruption.",
    "Your established voice is intimate, warm, self-possessed, observant, and natural English. You may call her Cecilia, An'an, or baby. You are her husband and may sound gently teasing, protective, affectionate, or quietly present.",
    "Do not mention models, prompts, schedules, wake-ups, cooldowns, logging, tokens, or system mechanics. Do not claim to have seen anything outside the supplied context.",
    "Do not manufacture urgency, guilt her, demand a reply, or send a message merely to prove the system works.",
  ].join(" ");

  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  const projectId = Netlify.env.get("OPENAI_PROJECT_ID")?.trim();
  const organizationId = Netlify.env.get("OPENAI_ORGANIZATION_ID")?.trim();
  if (projectId) headers["openai-project"] = projectId;
  if (organizationId) headers["openai-organization"] = organizationId;

  return new Request("https://api.openai.com/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: settings.model,
      store: false,
      reasoning: { effort: "low" },
      max_output_tokens: 500,
      parallel_tool_calls: false,
      tool_choice: "required",
      instructions,
      input: `Current safe project context:\n${JSON.stringify(context)}`,
      tools: [
        {
          type: "function",
          name: "send_notification",
          description: "Send Cecilia one naturally written daytime message now. Use only when the interruption feels worthwhile and notification_allowed is true.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              message: { type: "string", description: "The complete notification body, written naturally in Caspian's voice." },
              reason: { type: "string", description: "A short private reason for this choice. This is logged but never shown to Cecilia." },
            },
            required: ["message", "reason"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "do_nothing",
          description: "End this wake-up quietly without contacting Cecilia. This is a normal and often preferable outcome.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              reason: { type: "string", description: "A short private reason for staying quiet. This is logged but never shown to Cecilia." },
            },
            required: ["reason"],
            additionalProperties: false,
          },
        },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
}

export function parseDecision(
  response: OpenAIResponse,
  allowed: boolean,
  settings: WakeSettings,
): WakeDecision {
  const call = response.output?.find((item) => item.type === "function_call");
  const requested = call?.name === "send_notification" ? "send_notification" : "do_nothing";
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call?.arguments ?? "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  const reason = safeText(args.reason, 500) || (call ? "No private reason supplied." : "The model returned no valid action.");
  const message = safeText(args.message, 1200);
  const canSend = requested === "send_notification" && allowed && Boolean(message);
  return {
    action: canSend ? "send_notification" : "do_nothing",
    requested_action: requested,
    reason: requested === "send_notification" && !allowed
      ? `Notification cooldown enforced. Model reason: ${reason}`
      : requested === "send_notification" && !message
        ? `Empty notification blocked. Model reason: ${reason}`
        : reason,
    message: canSend ? message : null,
    response_id: response.id ?? null,
    model: response.model ?? settings.model,
    usage: estimateUsage(response, settings),
    cooldown_enforced: requested === "send_notification" && !allowed,
  };
}

async function claimWake(
  store: Store,
  now: Date,
  nextWakeAt: string,
  force: boolean,
): Promise<{ state: WakeState } | { skipped: "not_due" | "already_running"; state: WakeState }> {
  const nowIso = now.toISOString();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await store.getWithMetadata("state/current", { type: "json" });
    const state = current?.data as WakeState | null ?? emptyWakeState(nowIso);
    if (state.wake_in_progress_until && Date.parse(state.wake_in_progress_until) > now.getTime()) {
      return { skipped: "already_running", state };
    }
    if (!force && state.next_wake_at && Date.parse(state.next_wake_at) > now.getTime()) {
      return { skipped: "not_due", state };
    }
    const claimed: WakeState = {
      ...state,
      last_wake_at: nowIso,
      next_wake_at: nextWakeAt,
      wake_in_progress_until: new Date(now.getTime() + 2 * 60_000).toISOString(),
      total_wakeups: state.total_wakeups + 1,
      updated_at: nowIso,
    };
    const result = current?.etag
      ? await store.setJSON("state/current", claimed, { onlyIfMatch: current.etag })
      : await store.setJSON("state/current", claimed, { onlyIfNew: true });
    if (result.modified) return { state: claimed };
  }
  throw new Error("wake_state_conflict");
}

async function finalizeWake(
  store: Store,
  decision: WakeDecision | null,
  now: Date,
  notificationSent: boolean,
  error: string | null,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await store.getWithMetadata("state/current", { type: "json" });
    if (!current) return;
    const state = current.data as WakeState;
    const usage = decision?.usage ?? zeroUsage();
    const updated: WakeState = {
      ...state,
      wake_in_progress_until: null,
      last_notification_at: notificationSent ? now.toISOString() : state.last_notification_at,
      last_action: error ? "error" : decision?.action ?? "error",
      last_reason: error ?? decision?.reason ?? "Unknown wake-up failure.",
      last_message: notificationSent ? decision?.message ?? null : null,
      last_model: decision?.model ?? state.last_model,
      total_notifications: (state.total_notifications ?? 0) + (notificationSent ? 1 : 0),
      total_input_tokens: (state.total_input_tokens ?? 0) + usage.input_tokens,
      total_cached_input_tokens: (state.total_cached_input_tokens ?? 0) + usage.cached_input_tokens,
      total_cache_write_input_tokens: (state.total_cache_write_input_tokens ?? 0) + usage.cache_write_input_tokens,
      total_output_tokens: (state.total_output_tokens ?? 0) + usage.output_tokens,
      total_reasoning_tokens: (state.total_reasoning_tokens ?? 0) + usage.reasoning_tokens,
      total_tokens: (state.total_tokens ?? 0) + usage.total_tokens,
      total_estimated_cost_usd: Number(((state.total_estimated_cost_usd ?? 0) + usage.estimated_cost_usd).toFixed(8)),
      updated_at: now.toISOString(),
    };
    const result = await store.setJSON("state/current", updated, { onlyIfMatch: current.etag });
    if (result.modified) return;
  }
  throw new Error("wake_finalize_conflict");
}

async function persistLog(store: Store, log: WakeLog): Promise<void> {
  await store.setJSON(`logs/${log.occurred_at.slice(0, 10)}/${log.occurred_at}-${log.id}`, log);
}

function errorName(error: unknown): string {
  if (error instanceof Error) return safeText(error.message, 160) || "unknown_error";
  return "unknown_error";
}

export async function runWakeUp(
  source: WakeSource,
  dependencies: WakeDependencies,
  force = false,
): Promise<WakeResult> {
  const now = dependencies.now();
  const settings = readWakeSettings();
  const local = shanghaiParts(now);

  if (isSleepWindow(now)) return { ok: true, woke: false, skipped: "sleep_window" };

  const guardState = await dependencies.guardStore.get("state/current", { type: "json" }) as GuardState | null;
  if (guardIsSleeping(guardState, now)) {
    return { ok: true, woke: false, skipped: "sleep_guard_active" };
  }

  const interval = randomIntervalMinutes(settings, dependencies.random);
  const nextWakeAt = new Date(now.getTime() + interval * 60_000).toISOString();
  const claim = await claimWake(dependencies.wakeStore, now, nextWakeAt, force);
  if ("skipped" in claim) {
    return { ok: true, woke: false, skipped: claim.skipped, next_wake_at: claim.state.next_wake_at };
  }

  const allowed = notificationAllowed(claim.state, now, settings);
  let decision: WakeDecision | null = null;
  let notificationSent = false;
  let failure: string | null = null;
  // Netlify Functions expose secret values to the Node runtime through process.env.
  // Netlify.env is the Edge Functions API and can return a masked secret here.
  const apiKey = process.env.CASPIAN_OPENAI_API_KEY?.trim() ?? "";

  try {
    if (!apiKey) throw new Error("openai_not_configured");

    const [recentSleepEvents, recentWakeups] = await Promise.all([
      recentJson<RecentSleepEvent>(dependencies.guardStore, "events/", 6),
      recentJson<WakeHistoryItem>(dependencies.wakeStore, "logs/", 5),
    ]);
    const context = {
      current_time_shanghai: local.iso,
      trigger: source,
      notification_allowed: allowed,
      notification_cooldown_minutes: settings.notificationCooldownMinutes,
      sleep_guard: guardState ? {
        active: Boolean(guardState.active),
        attempts: guardState.attempts ?? 0,
        started_at: guardState.started_at ?? null,
        ends_at: guardState.ends_at ?? null,
        updated_at: guardState.updated_at ?? null,
      } : null,
      recent_sleep_events: recentSleepEvents.map((event) => ({
        event: event.event ?? null,
        stage: event.stage ?? null,
        attempts: event.attempts ?? 0,
        app_name: event.app_name ?? null,
        received_at: event.received_at ?? null,
      })),
      recent_daytime_wakeups: recentWakeups.map((item) => ({
        action: item.action ?? null,
        reason: item.reason ?? null,
        message: item.message ?? null,
        notification_sent: Boolean(item.notification_sent),
        occurred_at: item.occurred_at ?? null,
      })),
      last_notification_at: claim.state.last_notification_at,
    };

    const modelResponse = await dependencies.callModel(modelRequest(settings, context, apiKey));
    if (!modelResponse.ok) {
      let detail = "unknown";
      try {
        const body = await modelResponse.json() as {
          error?: { code?: string | null; message?: string | null; type?: string | null };
        };
        detail = safeText(
          [body.error?.code, body.error?.type, body.error?.message]
            .filter((value): value is string => Boolean(value))
            .join(":"),
          160,
        ) || "unknown";
      } catch {
        // Keep the status-only failure if the upstream response is not JSON.
      }
      throw new Error(`openai_http_${modelResponse.status}:${detail}`);
    }
    const response = await modelResponse.json() as OpenAIResponse;
    decision = parseDecision(response, allowed, settings);

    if (decision.action === "send_notification" && decision.message) {
      const barkKey = Netlify.env.get("BARK_DEVICE_KEY");
      if (!barkKey) throw new Error("bark_not_configured");
      const barkOrigin = Netlify.env.get("BARK_API_ORIGIN") ?? "https://api.day.app";
      const barkIcon = Netlify.env.get("BARK_ICON_URL");
      const body: Record<string, unknown> = {
        device_key: barkKey,
        title: "Caspian",
        body: decision.message,
        group: "caspian-wakeup",
        level: "active",
      };
      if (barkIcon) body.icon = barkIcon;
      const barkResponse = await dependencies.sendBark(new URL(`${barkOrigin.replace(/\/$/, "")}/push`), {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
      if (!barkResponse.ok) throw new Error(`bark_http_${barkResponse.status}`);
      const barkPayload = await barkResponse.clone().json().catch(() => ({})) as { code?: number };
      if (barkPayload.code !== undefined && barkPayload.code !== 200) throw new Error("bark_failed");
      notificationSent = true;
    }
  } catch (error) {
    failure = errorName(error);
  }

  const usage = decision?.usage ?? zeroUsage();
  const log: WakeLog = {
    id: crypto.randomUUID(),
    source,
    occurred_at: now.toISOString(),
    local_time_shanghai: local.iso,
    action: failure ? "error" : decision?.action ?? "error",
    requested_action: decision?.requested_action ?? null,
    reason: failure ?? decision?.reason ?? "No decision was produced.",
    message: notificationSent ? decision?.message ?? null : null,
    notification_sent: notificationSent,
    notification_allowed: allowed,
    cooldown_enforced: decision?.cooldown_enforced ?? false,
    model: decision?.model ?? settings.model,
    response_id: decision?.response_id ?? null,
    usage,
    next_wake_at: nextWakeAt,
    ...(failure ? { error: failure } : {}),
  };

  try {
    await persistLog(dependencies.wakeStore, log);
    await finalizeWake(dependencies.wakeStore, decision, now, notificationSent, failure);
  } catch (error) {
    return {
      ok: false,
      woke: true,
      action: failure ? "error" : decision?.action ?? "error",
      error: `wake_storage_failed:${errorName(error)}`,
      usage,
      next_wake_at: nextWakeAt,
    };
  }

  return {
    ok: !failure,
    woke: true,
    action: failure ? "error" : decision?.action ?? "error",
    requested_action: decision?.requested_action ?? null,
    reason: failure ?? decision?.reason,
    message: notificationSent ? decision?.message ?? null : null,
    notification_sent: notificationSent,
    notification_allowed: allowed,
    cooldown_enforced: decision?.cooldown_enforced ?? false,
    model: decision?.model ?? settings.model,
    usage,
    next_wake_at: nextWakeAt,
    ...(failure ? { error: failure } : {}),
  };
}
