// Owner-only server settings: store the Anthropic key in Vault (never returned to the browser), test it.
import { z } from "zod";
import { audit, clearConfigCache, config, handler, HttpError, json, readJson, requireUser, serviceClient } from "../_shared/edge.ts";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }),
  z.object({ action: z.literal("set_anthropic_key"), key: z.string().regex(/^sk-ant-[A-Za-z0-9_-]{20,}$/, "Ключ должен начинаться с sk-ant-") }),
  z.object({ action: z.literal("clear_anthropic_key") }),
]);

export default handler(async (req) => {
  const { userId } = await requireUser(req);
  const db = serviceClient();
  const { data: isOwner } = await db.rpc("is_app_owner", { p_user: userId });
  if (!isOwner) throw new HttpError(403, "Только владелец приложения", "forbidden");
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join("; "), "bad_request");
  const b = parsed.data;

  if (b.action === "status") {
    const key = await config("ANTHROPIC_API_KEY", "anthropic_api_key");
    return json(req, {
      anthropic: key ? { configured: true, hint: `${key.slice(0, 10)}…${key.slice(-4)}` } : { configured: false },
      pricing_configured: Boolean(Deno.env.get("AI_PRICING_JSON")),
      model_default: Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5",
    });
  }
  if (b.action === "set_anthropic_key") {
    // verify with a tiny request before storing
    const res = await fetch("https://api.anthropic.com/v1/models", { headers: { "x-api-key": b.key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!res || res.status === 401 || res.status === 403) throw new HttpError(422, "Anthropic не принял ключ", "invalid_key");
    const { error } = await db.rpc("set_app_secret", { p_name: "anthropic_api_key", p_value: b.key });
    if (error) throw new HttpError(500, "Не удалось сохранить ключ: " + error.message);
    clearConfigCache();
    await audit(db, userId, "info", "settings_changed", null, "Ключ Claude обновлён");
    return json(req, { ok: true, models_ok: res.ok });
  }
  const { error } = await db.rpc("set_app_secret", { p_name: "anthropic_api_key", p_value: null });
  if (error) throw new HttpError(500, error.message);
  clearConfigCache();
  await audit(db, userId, "info", "settings_changed", null, "Ключ Claude удалён");
  return json(req, { ok: true });
});
