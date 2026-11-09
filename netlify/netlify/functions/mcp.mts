import { getStore, type Store } from "@netlify/blobs";

const MCP_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26"]);
const DEFAULT_MCP_PROTOCOL_VERSION = "2025-03-26";
const WRITE_SCOPE = "sleep_guard:write";
const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
type JsonObject = Record<string, unknown>;

type OAuthClient = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: string;
};

type AuthorizationRequest = {
  id: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  scope: string;
  code_challenge: string;
  approval_token_hash: string;
  status: "pending" | "approved" | "completed";
  created_at: string;
  expires_at: string;
  approved_at?: string;
  redirect_url?: string;
};

type AuthorizationCode = {
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  created_at: string;
  expires_at: string;
  used: boolean;
};

type AccessToken = {
  client_id: string;
  scope: string;
  created_at: string;
  expires_at: string;
};

type GuardResult = {
  ok: boolean;
  active?: boolean;
  attempts?: number;
  stage?: string;
  session_id?: string | null;
  error?: string;
};

export type McpDependencies = {
  activateGuard: () => Promise<GuardResult>;
  readGuardState: () => Promise<JsonObject | null>;
};

function json(status: number, body: unknown, extraHeaders: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function oauthJson(status: number, body: unknown): Response {
  return json(status, body, { pragma: "no-cache" });
}

function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;",
  })[character] ?? character);
}

function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

async function loadJson<T>(store: Store, key: string): Promise<T | null> {
  return await store.get(key, { type: "json" }) as T | null;
}

function origin(request: Request): string {
  return new URL(request.url).origin;
}

function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function protectedResourceMetadata(request: Request): Response {
  const base = origin(request);
  return json(200, {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: [WRITE_SCOPE],
  });
}

function authorizationServerMetadata(request: Request): Response {
  const base = origin(request);
  return json(200, {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [WRITE_SCOPE],
  });
}

export async function registerClient(request: Request, store: Store): Promise<Response> {
  if (request.method !== "POST") return oauthJson(405, { error: "method_not_allowed" });
  let input: JsonObject;
  try {
    input = await request.json() as JsonObject;
  } catch {
    return oauthJson(400, { error: "invalid_client_metadata" });
  }

  const redirectUris = Array.isArray(input.redirect_uris)
    ? input.redirect_uris.filter(isAllowedRedirectUri)
    : [];
  if (redirectUris.length === 0 || redirectUris.length !== (input.redirect_uris as unknown[])?.length) {
    return oauthJson(400, { error: "invalid_redirect_uri" });
  }
  if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== "none") {
    return oauthJson(400, { error: "invalid_client_metadata" });
  }

  const clientId = randomToken(24);
  const createdAt = new Date().toISOString();
  const client: OAuthClient = {
    client_id: clientId,
    client_name: typeof input.client_name === "string" ? input.client_name.slice(0, 120) : "ChatGPT",
    redirect_uris: redirectUris,
    created_at: createdAt,
  };
  await store.setJSON(`clients/${clientId}`, client);
  return oauthJson(201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.parse(createdAt) / 1000),
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

async function sendApprovalBark(approvalUrl: string, clientName: string): Promise<boolean> {
  const barkKey = Netlify.env.get("BARK_DEVICE_KEY");
  const barkOrigin = Netlify.env.get("BARK_API_ORIGIN") ?? "https://api.day.app";
  const barkIcon = Netlify.env.get("BARK_ICON_URL")
    ?? new URL("/assets/c-avatar-v4.png", approvalUrl).href;
  if (!barkKey) return false;

  try {
    const response = await fetch(`${barkOrigin.replace(/\/$/, "")}/push`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        device_key: barkKey,
        title: "Caspian",
        body: `${clientName || "ChatGPT"} is asking to connect to Sleepy Dog Lock. Only open this if you just started the connection, Cecilia.`,
        group: "sleep-guard-auth",
        level: "timeSensitive",
        icon: barkIcon,
        url: approvalUrl,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return false;
    const body = await response.clone().json().catch(() => ({})) as { code?: number };
    return body.code === undefined || body.code === 200;
  } catch {
    return false;
  }
}

function oauthErrorRedirect(redirectUri: string, state: string, error: string): Response {
  const destination = new URL(redirectUri);
  destination.searchParams.set("error", error);
  destination.searchParams.set("state", state);
  return Response.redirect(destination, 302);
}

export async function beginAuthorization(
  request: Request,
  store: Store,
  sendApproval: (approvalUrl: string, clientName: string) => Promise<boolean> = sendApprovalBark,
): Promise<Response> {
  if (request.method !== "GET") return oauthJson(405, { error: "method_not_allowed" });
  const url = new URL(request.url);
  const responseType = url.searchParams.get("response_type");
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const scope = url.searchParams.get("scope") || WRITE_SCOPE;
  const challenge = url.searchParams.get("code_challenge") ?? "";
  const challengeMethod = url.searchParams.get("code_challenge_method");

  const client = await loadJson<OAuthClient>(store, `clients/${clientId}`);
  if (!client || !client.redirect_uris.includes(redirectUri)) {
    return oauthJson(400, { error: "invalid_request", error_description: "Unknown client or redirect URI" });
  }
  if (responseType !== "code" || !state || scope !== WRITE_SCOPE || challengeMethod !== "S256" || challenge.length < 43) {
    return oauthErrorRedirect(redirectUri, state, "invalid_request");
  }

  const now = new Date();
  const lastApproval = await loadJson<{ sent_at?: string }>(store, "throttle/last-approval");
  if (lastApproval?.sent_at && Date.parse(lastApproval.sent_at) > now.getTime() - 20_000) {
    return oauthErrorRedirect(redirectUri, state, "temporarily_unavailable");
  }
  await store.setJSON("throttle/last-approval", { sent_at: now.toISOString() });
  const requestId = randomToken(24);
  const approvalToken = randomToken(32);
  const authRequest: AuthorizationRequest = {
    id: requestId,
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope,
    code_challenge: challenge,
    approval_token_hash: await digest(approvalToken),
    status: "pending",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + AUTH_REQUEST_TTL_MS).toISOString(),
  };
  await store.setJSON(`requests/${requestId}`, authRequest);

  const approvalUrl = new URL("/oauth/approve", origin(request));
  approvalUrl.searchParams.set("id", requestId);
  approvalUrl.searchParams.set("token", approvalToken);
  if (!await sendApproval(String(approvalUrl), client.client_name)) {
    return oauthErrorRedirect(redirectUri, state, "temporarily_unavailable");
  }

  const safeClientName = escapeHtml(client.client_name || "ChatGPT");
  const requestIdJson = JSON.stringify(requestId);
  return html(200, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Caspian · Sleepy Dog Lock</title><style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111016;color:#f7f4ff;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif}.card{width:min(86vw,420px);padding:34px;border:1px solid #ffffff26;border-radius:30px;background:linear-gradient(145deg,#ffffff18,#ffffff08);box-shadow:0 30px 90px #0008;backdrop-filter:blur(22px);text-align:center}.mark{font-size:42px;margin-bottom:16px}.muted{color:#c7c0d4;line-height:1.55}.pulse{display:inline-block;width:9px;height:9px;border-radius:50%;background:#9d7cff;box-shadow:0 0 18px #9d7cff;margin-right:8px;animation:p 1.5s infinite}@keyframes p{50%{opacity:.35}}
</style></head><body><main class="card"><div class="mark">C</div><h1>One tap and you're in</h1><p class="muted"><span class="pulse"></span>I sent the approval link to Bark. Make sure you just connected ${safeClientName}, then open the notification.</p><p id="status" class="muted">Waiting for you, Cecilia…</p></main><script>
const id=${requestIdJson};let stopped=false;async function poll(){if(stopped)return;try{const r=await fetch('/oauth/pending?id='+encodeURIComponent(id),{cache:'no-store'});const d=await r.json();if(d.redirect){stopped=true;location.replace(d.redirect);return}if(d.error){stopped=true;document.getElementById('status').textContent='That approval expired. Go back to ChatGPT and try connecting again.';return}}catch{}setTimeout(poll,1200)}poll();
</script></body></html>`);
}

export async function approveAuthorization(request: Request, store: Store): Promise<Response> {
  if (request.method !== "GET") return oauthJson(405, { error: "method_not_allowed" });
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  const token = url.searchParams.get("token") ?? "";
  const authRequest = await loadJson<AuthorizationRequest>(store, `requests/${id}`);
  if (!authRequest || authRequest.status !== "pending" || Date.parse(authRequest.expires_at) <= Date.now()) {
    return html(400, "<!doctype html><meta charset=\"utf-8\"><title>Caspian</title><p>That approval expired. Go back to ChatGPT and try connecting again.</p>");
  }
  if (!token || await digest(token) !== authRequest.approval_token_hash) {
    return html(403, "<!doctype html><meta charset=\"utf-8\"><title>Caspian</title><p>That approval link isn't valid.</p>");
  }

  await store.setJSON(`requests/${id}`, {
    ...authRequest,
    status: "approved",
    approved_at: new Date().toISOString(),
  });
  return html(200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Caspian · Approved</title><style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111016;color:#fff;font-family:-apple-system,sans-serif}.card{margin:24px;padding:34px;border:1px solid #ffffff26;border-radius:28px;background:#ffffff10;text-align:center}p{color:#cbc4d6;line-height:1.55}</style></head><body><main class="card"><h1>You're all set.</h1><p>Go back to the ChatGPT connection page. It'll finish automatically.</p></main></body></html>`);
}

export async function authorizationStatus(request: Request, store: Store): Promise<Response> {
  if (request.method !== "GET") return oauthJson(405, { error: "method_not_allowed" });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const authRequest = await loadJson<AuthorizationRequest>(store, `requests/${id}`);
  if (!authRequest || Date.parse(authRequest.expires_at) <= Date.now()) {
    return oauthJson(410, { error: "expired" });
  }
  if (authRequest.status === "pending") return oauthJson(200, { pending: true });
  if (authRequest.redirect_url) return oauthJson(200, { redirect: authRequest.redirect_url });
  if (authRequest.status !== "approved") return oauthJson(409, { error: "invalid_state" });

  const code = randomToken(32);
  const codeRecord: AuthorizationCode = {
    client_id: authRequest.client_id,
    redirect_uri: authRequest.redirect_uri,
    scope: authRequest.scope,
    code_challenge: authRequest.code_challenge,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString(),
    used: false,
  };
  await store.setJSON(`codes/${await digest(code)}`, codeRecord);
  const redirect = new URL(authRequest.redirect_uri);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", authRequest.state);
  const redirectUrl = String(redirect);
  await store.setJSON(`requests/${id}`, { ...authRequest, status: "completed", redirect_url: redirectUrl });
  return oauthJson(200, { redirect: redirectUrl });
}

export async function exchangeToken(request: Request, store: Store): Promise<Response> {
  if (request.method !== "POST") return oauthJson(405, { error: "method_not_allowed" });
  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type");
  const code = form.get("code") ?? "";
  const clientId = form.get("client_id") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  if (grantType !== "authorization_code" || !code || !clientId || !redirectUri || verifier.length < 43) {
    return oauthJson(400, { error: "invalid_request" });
  }

  const codeKey = `codes/${await digest(code)}`;
  const record = await loadJson<AuthorizationCode>(store, codeKey);
  if (!record || record.used || Date.parse(record.expires_at) <= Date.now()) {
    return oauthJson(400, { error: "invalid_grant" });
  }
  if (record.client_id !== clientId || record.redirect_uri !== redirectUri || await digest(verifier) !== record.code_challenge) {
    return oauthJson(400, { error: "invalid_grant" });
  }

  await store.setJSON(codeKey, { ...record, used: true });
  const accessToken = randomToken(32);
  const tokenRecord: AccessToken = {
    client_id: clientId,
    scope: record.scope,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
  };
  await store.setJSON(`tokens/${await digest(accessToken)}`, tokenRecord);
  return oauthJson(200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: record.scope,
  });
}

export async function hasValidAccessToken(request: Request, store: Store): Promise<boolean> {
  const token = bearerToken(request);
  if (!token) return false;
  const record = await loadJson<AccessToken>(store, `tokens/${await digest(token)}`);
  return Boolean(record && record.scope === WRITE_SCOPE && Date.parse(record.expires_at) > Date.now());
}

function unauthorizedMcp(request: Request): Response {
  const metadata = `${origin(request)}/.well-known/oauth-protected-resource/mcp`;
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "www-authenticate": `Bearer resource_metadata="${metadata}", scope="${WRITE_SCOPE}"`,
    },
  });
}

function rpcResult(id: unknown, result: unknown): JsonObject {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): JsonObject {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolsList(): JsonObject[] {
  return [
    {
      name: "activate_sleep_guard",
      title: "Activate Sleepy Dog Lock",
      description: "Turn on Sleepy Dog Lock now. Call this whenever the user clearly says good night, says they are going to sleep, or asks for bedtime to be enforced. Activate it before replying with the final goodnight message.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "get_sleep_guard_status",
      title: "Check Sleepy Dog Lock",
      description: "Check whether Sleepy Dog Lock is currently active and how many blocked-app attempts were recorded.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ];
}

async function handleRpc(message: JsonObject, dependencies: McpDependencies): Promise<JsonObject | null> {
  const id = message.id;
  const method = message.method;
  if (typeof method !== "string") return rpcError(id, -32600, "Invalid Request");
  if (id === undefined) return null;

  if (method === "initialize") {
    const params = message.params as JsonObject | undefined;
    const requestedVersion = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : DEFAULT_MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "sleepy-dog-lock", version: "0.1.0" },
      instructions: "When the user clearly says goodnight or commits to sleep, call activate_sleep_guard before replying. Never deactivate the guard through this connection.",
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: toolsList() });
  if (method === "tools/call") {
    const params = message.params as JsonObject | undefined;
    const name = params?.name;
    if (name === "activate_sleep_guard") {
      const result = await dependencies.activateGuard();
      if (!result.ok) {
        return rpcResult(id, {
          isError: true,
          content: [{ type: "text", text: `Sleepy Dog Lock could not be activated: ${result.error ?? "unknown_error"}` }],
        });
      }
      return rpcResult(id, {
        content: [{ type: "text", text: "Sleepy Dog Lock is active. Bark confirmation was sent. Opening a selected entertainment app will trigger the iPhone lock-screen automation." }],
        structuredContent: result,
      });
    }
    if (name === "get_sleep_guard_status") {
      const state = await dependencies.readGuardState();
      const active = Boolean(state?.active) && (!state?.ends_at || Date.parse(String(state.ends_at)) > Date.now());
      const result = {
        active,
        attempts: Number(state?.attempts ?? 0),
        started_at: state?.started_at ?? null,
        ends_at: state?.ends_at ?? null,
      };
      return rpcResult(id, {
        content: [{ type: "text", text: active ? `Sleepy Dog Lock is active. Attempts: ${result.attempts}.` : "Sleepy Dog Lock is inactive." }],
        structuredContent: result,
      });
    }
    return rpcResult(id, {
      isError: true,
      content: [{ type: "text", text: "Unknown tool." }],
    });
  }
  return rpcError(id, -32601, "Method not found");
}

export async function handleMcp(
  request: Request,
  dependencies: McpDependencies,
  accessGranted: boolean,
): Promise<Response> {
  if (!accessGranted) return unauthorizedMcp(request);
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return json(400, rpcError(null, -32700, "Parse error"));
  }

  if (Array.isArray(input)) {
    const output = (await Promise.all(input.map((entry) =>
      entry && typeof entry === "object" ? handleRpc(entry as JsonObject, dependencies) : rpcError(null, -32600, "Invalid Request")
    ))).filter(Boolean);
    return output.length ? json(200, output) : new Response(null, { status: 202 });
  }
  if (!input || typeof input !== "object") return json(200, rpcError(null, -32600, "Invalid Request"));
  const output = await handleRpc(input as JsonObject, dependencies);
  return output ? json(200, output) : new Response(null, { status: 202 });
}

async function productionDependencies(request: Request): Promise<McpDependencies> {
  const eventStore = getStore({ name: "sleep-guard-events", consistency: "strong" });
  return {
    activateGuard: async () => {
      const token = Netlify.env.get("SLEEP_GUARD_SHORTCUT_TOKEN");
      if (!token) return { ok: false, error: "guard_not_configured" };
      try {
        const response = await fetch(new URL("/api/sleep-guard-event", request.url), {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            event: "sleep_guard_started",
            source: "chatgpt_mcp",
            request_id: crypto.randomUUID(),
          }),
          signal: AbortSignal.timeout(12_000),
        });
        const result = await response.json().catch(() => ({ ok: false, error: "invalid_guard_response" })) as GuardResult;
        return response.ok ? result : { ok: false, error: result.error ?? "guard_request_failed" };
      } catch {
        return { ok: false, error: "guard_request_failed" };
      }
    },
    readGuardState: async () => await eventStore.get("state/current", { type: "json" }) as JsonObject | null,
  };
}

export default async (request: Request): Promise<Response> => {
  const pathname = new URL(request.url).pathname;
  const authStore = getStore({ name: "sleep-guard-mcp-auth", consistency: "strong" });

  if (pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp") {
    return protectedResourceMetadata(request);
  }
  if (pathname === "/.well-known/oauth-authorization-server") return authorizationServerMetadata(request);
  if (pathname === "/oauth/register") return registerClient(request, authStore);
  if (pathname === "/oauth/authorize") return beginAuthorization(request, authStore);
  if (pathname === "/oauth/approve") return approveAuthorization(request, authStore);
  if (pathname === "/oauth/pending") return authorizationStatus(request, authStore);
  if (pathname === "/oauth/token") return exchangeToken(request, authStore);
  if (pathname === "/mcp") {
    return handleMcp(request, await productionDependencies(request), await hasValidAccessToken(request, authStore));
  }
  return json(404, { error: "not_found" });
};

export const config = {
  path: [
    "/mcp",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/oauth/register",
    "/oauth/authorize",
    "/oauth/pending",
    "/oauth/approve",
    "/oauth/token",
  ],
};
