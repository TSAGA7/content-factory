import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(SUPABASE_URL, KEY, { auth: { persistSession: true, autoRefreshToken: true } });

export class ApiError extends Error {
  constructor(message: string, public code?: string, public data?: Record<string, unknown>) { super(message); }
}

/** Call an Edge Function route (single deployment "cf"). */
export async function fn<T = Record<string, unknown>>(name: string, body: unknown): Promise<T> {
  const { data: s } = await supabase.auth.getSession();
  const token = s.session?.access_token;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/cf/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Ошибка ${res.status}`, (data as { code?: string }).code, data);
  return data as T;
}

export async function rpc<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new ApiError(error.message, error.code);
  return data as T;
}

/** Throw on Supabase error, return data. */
export function must<T>(r: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (r.error) throw new ApiError(r.error.message, r.error.code);
  return r.data as T;
}
