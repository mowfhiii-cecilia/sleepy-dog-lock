import { getStore } from "@netlify/blobs";
import { readWakeSettings, type WakeLog, type WakeState } from "./_shared/caspian-wakeup-core.mts";

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

export default async (request: Request): Promise<Response> => {
  if (request.method !== "GET") return json(405, { ok: false, error: "method_not_allowed" });
  const expectedToken = Netlify.env.get("SLEEP_GUARD_SHORTCUT_TOKEN");
  if (!expectedToken || bearerToken(request) !== expectedToken) {
    return json(401, { ok: false, error: "unauthorized" });
  }

  const store = getStore({ name: "caspian-wakeup", consistency: "strong" });
  const [state, listed] = await Promise.all([
    store.get("state/current", { type: "json" }) as Promise<WakeState | null>,
    store.list({ prefix: "logs/" }),
  ]);
  const keys = listed.blobs.map((blob) => blob.key).sort().reverse().slice(0, 20);
  const recent = (await Promise.all(
    keys.map((key) => store.get(key, { type: "json" }) as Promise<WakeLog | null>),
  )).filter((entry): entry is WakeLog => entry !== null);
  const settings = readWakeSettings();

  return json(200, {
    ok: true,
    settings: {
      model: settings.model,
      wake_interval_minutes: {
        minimum: settings.minIntervalMinutes,
        maximum: settings.maxIntervalMinutes,
        scheduler_resolution: 10,
      },
      notification_cooldown_minutes: settings.notificationCooldownMinutes,
      pricing_snapshot_usd_per_million_tokens: settings.pricing,
    },
    state,
    recent_wakeups: recent,
  });
};

export const config = {
  path: "/api/caspian-wakeup-status",
  method: ["GET"],
};
