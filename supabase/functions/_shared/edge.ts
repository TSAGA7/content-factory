// Shared helpers for Edge Functions: CORS, responses, auth, config, redaction.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

export type Db = SupabaseClient;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

let _service: Db | null = null;
export function serviceClient(): Db {
  if (!_service) _service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  return _service;
}

const cache = new Map<string, { v: string | null; at: number }>();
/** Config: Edge Function env first, then Vault (via service-only RPC). Cached 60 s per instance. */
export async function config(envName: string, vaultName?: string): Promise<string | null> {
  const env = Deno.env.get(envName);
  if (env) return env;
  if (!vaultName) return null;
  const hit = cache.get(vaultName);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const { data, error } = await serviceClient().rpc("get_app_secret", { p_name: vaultName });
  if (error) throw new Error(`config ${vaultName}: ${error.message}`);
  const v = (data as string | null) ?? null;
  cache.set(vaultName, { v, at: Date.now() });
  return v;
}
export function clearConfigCache() { cache.clear(); }

function allowedOrigin(req: Request): string {
  const origin = req.headers.get("origin") ?? "";
  const list = (Deno.env.get("APP_ORIGINS") ?? "http://localhost:5173,https://tsaga7.github.io").split(",").map((s) => s.trim());
  return list.includes(origin) ? origin : list[0] ?? "*";
}

export function corsHeaders(req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowedOrigin(req),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Vary": "Origin",
  };
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = "error") { super(message); }
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), "Content-Type": "application/json" } });
}

/** Wrap a handler with CORS preflight and uniform error responses. */
export function handler(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return json(req, { error: e.message, code: e.code }, e.status);
      console.error("unhandled", redact(String((e as Error)?.stack ?? e)));
      return json(req, { error: "Внутренняя ошибка сервера", code: "internal" }, 500);
    }
  };
}

export async function requireUser(req: Request): Promise<{ userId: string; userClient: Db }> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) throw new HttpError(401, "Требуется вход", "unauthorized");
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser(auth.slice(7));
  if (error || !data.user) throw new HttpError(401, "Сессия недействительна", "unauthorized");
  rateLimit(data.user.id);
  return { userId: data.user.id, userClient };
}

export async function requireWorker(req: Request): Promise<void> {
  const got = req.headers.get("x-worker-secret") ?? "";
  const expected = await config("WORKER_SECRET", "worker_secret");
  if (!expected || !timingSafeEqual(got, expected)) throw new HttpError(401, "forbidden", "unauthorized");
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

const hits = new Map<string, number[]>();
function rateLimit(key: string, max = 60, windowMs = 60_000) {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) throw new HttpError(429, "Слишком много запросов, подождите минуту", "rate_limit");
  arr.push(now);
  hits.set(key, arr);
}

const SECRET_PATTERNS: RegExp[] = [
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,           // Telegram bot token
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,             // Anthropic
  /\bya29\.[A-Za-z0-9._-]+\b/g,                 // Google access token
  /\b1\/\/[A-Za-z0-9._-]{20,}\b/g,              // Google refresh token
  /\b(IG|EAA)[A-Za-z0-9]{30,}\b/g,              // Meta tokens
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\/bot\d+:[A-Za-z0-9_-]+\//g,                 // token inside Telegram URL
];
/** Remove secrets from strings/objects before logging or storing. */
export function redact<T>(v: T): T {
  if (typeof v === "string") {
    let s: string = v;
    for (const re of SECRET_PATTERNS) s = s.replace(re, "[redacted]");
    return s as T;
  }
  if (Array.isArray(v)) return v.map((x) => redact(x)) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = /token|secret|password|authorization|api_?key/i.test(k) ? "[redacted]" : redact(val);
    }
    return out as T;
  }
  return v;
}

export async function audit(db: Db, ownerId: string, level: "info" | "warn" | "error", event: string,
  entity: { type?: string; id?: string } | null, message: string, details: Record<string, unknown> = {}) {
  await db.from("audit_logs").insert({
    owner_id: ownerId, level, event, entity_type: entity?.type ?? null, entity_id: entity?.id ?? null,
    message: redact(message), details: redact(details),
  });
}

export async function notify(db: Db, ownerId: string, level: "info" | "warn" | "error", title: string, body?: string, link?: string) {
  await db.from("notifications").insert({ owner_id: ownerId, level, title, body: body ? redact(body) : null, link: link ?? null });
}

export async function readJson<T = unknown>(req: Request): Promise<T> {
  try { return await req.json() as T; } catch { throw new HttpError(400, "Некорректный JSON", "bad_request"); }
}
