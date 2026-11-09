import { getStore } from "@netlify/blobs";
import { runWakeUp } from "./_shared/caspian-wakeup-core.mts";

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

export default async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  const expectedToken = Netlify.env.get("SLEEP_GUARD_SHORTCUT_TOKEN");
  if (!expectedToken || bearerToken(request) !== expectedToken) {
    return json(401, { ok: false, error: "unauthorized" });
  }

  const result = await runWakeUp("manual_test", {
    wakeStore: getStore({ name: "caspian-wakeup", consistency: "strong" }),
    guardStore: getStore({ name: "sleep-guard-events", consistency: "strong" }),
    callModel: fetch,
    sendBark: fetch,
    random: Math.random,
    now: () => new Date(),
  }, true);
  return json(result.ok ? 200 : 502, result as unknown as Record<string, unknown>);
};

export const config = {
  path: "/api/caspian-wakeup-test",
  method: ["POST"],
};
