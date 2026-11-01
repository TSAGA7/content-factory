// Connect / check / disconnect platform accounts. Tokens are stored only if the platform accepted them.
import { z } from "zod";
import { checkTelegram } from "../_shared/adapters.ts";
import { deleteCredentials, loadCredentials, saveCredentials } from "../_shared/crypto.ts";
import { audit, handler, HttpError, json, readJson, requireUser, serviceClient } from "../_shared/edge.ts";

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("telegram"),
    account_id: z.string().uuid().optional(), // reconnect existing
    bot_token: z.string().regex(/^\d{6,12}:[A-Za-z0-9_-]{30,}$/, "Неверный формат токена бота"),
    chat: z.string().regex(/^(@[A-Za-z0-9_]{4,64}|-?\d{5,20})$/, "Укажите @username канала или числовой ID"),
    name: z.string().max(120).optional(),
    brand_id: z.string().uuid().nullish(),
    timezone: z.string().max(64).optional(),
  }),
  z.object({ action: z.literal("check"), account_id: z.string().uuid() }),
  z.object({ action: z.literal("disconnect"), account_id: z.string().uuid() }),
]);

export default handler(async (req) => {
  const { userId, userClient } = await requireUser(req);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join("; "), "bad_request");
  const b = parsed.data;
  const db = serviceClient();

  if (b.action === "telegram") {
    const c = await checkTelegram(b.bot_token, b.chat);
    if (!c.chatId) return json(req, { ok: false, status: c.status, message: c.message }, 422);
    if (b.brand_id) {
      const { data: br } = await userClient.from("brands").select("id").eq("id", b.brand_id).maybeSingle();
      if (!br) throw new HttpError(404, "Бренд не найден", "not_found");
    }
    let accountId = b.account_id;
    if (accountId) {
      const { data: own } = await userClient.from("social_accounts").select("id, external_id").eq("id", accountId).maybeSingle();
      if (!own) throw new HttpError(404, "Аккаунт не найден", "not_found");
      if (own.external_id && own.external_id !== c.chatId) throw new HttpError(409, "Это другой канал — создайте новый аккаунт", "conflict");
    } else {
      const { data: dup } = await db.from("social_accounts").select("id").eq("owner_id", userId).eq("platform", "telegram").eq("external_id", c.chatId).maybeSingle();
      if (dup) throw new HttpError(409, "Этот канал уже подключён", "duplicate");
    }
    const row = {
      owner_id: userId, platform: "telegram", external_id: c.chatId,
      name: b.name?.trim() || c.title || b.chat, handle: c.username ? `@${c.username}` : null,
      url: c.username ? `https://t.me/${c.username}` : null,
      connection_status: c.status, capabilities: { formats: ["text", "photo", "video", "album"], bot: c.botUsername },
      scopes: c.ok ? ["can_post_messages"] : [], last_checked_at: new Date().toISOString(),
      last_error: c.ok ? null : c.message, last_error_at: c.ok ? null : new Date().toISOString(),
      ...(b.timezone ? { timezone: b.timezone } : {}),
      ...(b.brand_id !== undefined ? { brand_id: b.brand_id } : {}),
    };
    const q = accountId ? db.from("social_accounts").update(row).eq("id", accountId) : db.from("social_accounts").insert(row);
    const { data: acc, error } = await q.select("id").single();
    if (error) throw new HttpError(500, "Не удалось сохранить аккаунт: " + error.message);
    // token is valid (getMe succeeded) → store it encrypted even if rights are missing, so the user can fix rights and re-check
    await saveCredentials(acc.id, userId, { bot_token: b.bot_token });
    await audit(db, userId, c.ok ? "info" : "warn", "account_connected", { type: "social_account", id: acc.id }, `Telegram «${row.name}»: ${c.message}`);
    return json(req, { ok: c.ok, account_id: acc.id, status: c.status, message: c.message });
  }

  const { data: account } = await userClient.from("social_accounts").select("*").eq("id", b.account_id).maybeSingle();
  if (!account) throw new HttpError(404, "Аккаунт не найден", "not_found");

  if (b.action === "check") {
    if (account.connection_status === "mock") return json(req, { ok: true, status: "mock", message: "Тестовый аккаунт (mock)" });
    if (account.platform !== "telegram") return json(req, { ok: false, status: account.connection_status, message: "Проверка этой площадки появится в следующей версии" });
    const creds = await loadCredentials<{ bot_token: string }>(account.id);
    if (!creds) return json(req, { ok: false, status: "pending", message: "Нет сохранённого токена — подключите заново" });
    const c = await checkTelegram(creds.bot_token, account.external_id ?? account.handle);
    const now = new Date().toISOString();
    await db.from("social_accounts").update({ connection_status: c.status, last_checked_at: now, last_error: c.ok ? null : c.message, last_error_at: c.ok ? null : now }).eq("id", account.id);
    if (c.ok) {
      const { data: jobs } = await db.from("publishing_jobs").select("id, post_id").eq("account_id", account.id).eq("status", "blocked").in("last_error_category", ["auth", "permission"]);
      for (const j of jobs ?? []) {
        await db.from("publishing_jobs").update({ status: "queued", run_at: now, last_error: null }).eq("id", j.id);
        await db.from("content_posts").update({ status: "scheduled", last_error: null }).eq("id", j.post_id);
      }
    }
    await audit(db, userId, c.ok ? "info" : "warn", "connection_checked", { type: "social_account", id: account.id }, `«${account.name}»: ${c.message}`);
    return json(req, { ok: c.ok, status: c.status, message: c.message });
  }

  // disconnect
  await deleteCredentials(account.id);
  await db.from("social_accounts").update({ connection_status: "revoked", scopes: [] }).eq("id", account.id);
  await audit(db, userId, "info", "account_disconnected", { type: "social_account", id: account.id }, `«${account.name}» отключён, токен удалён`);
  return json(req, { ok: true, status: "revoked", message: account.platform === "telegram" ? "Токен удалён. Чтобы полностью отозвать доступ, удалите бота из администраторов канала или выполните /revoke в @BotFather." : "Доступ удалён" });
});
