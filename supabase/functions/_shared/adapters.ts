// Platform adapters. New platform = new adapter + entry in CAPABILITIES + registry line.
import { composeText, PublishError, type MediaInfo, type Platform, type PostFormat } from "./domain.ts";

export interface AdapterMedia extends MediaInfo { file_name: string; signedUrl: string }

export interface PublishCtx {
  jobId: string;
  post: { id: string; format: PostFormat; title: string | null; body: string; hashtags: string[]; platform_options: Record<string, unknown> };
  account: { id: string; external_id: string | null; handle: string | null; connection_status: string };
  media: AdapterMedia[];
  credentials: Record<string, unknown> | null;
  checkpoint: Record<string, unknown>;
  /** Persist checkpoint; throws if the lease is lost (abort before external call). */
  saveCheckpoint(cp: Record<string, unknown>): Promise<void>;
}

export type PublishOutcome =
  | { kind: "published"; externalId: string; url: string | null; isMock?: boolean }
  | { kind: "in_progress"; runAfterSec: number; checkpoint: Record<string, unknown> }
  | { kind: "platform_scheduled"; externalId: string; url: string | null; publishAt: string };

export type ReconcileOutcome = { kind: "found"; externalId: string; url: string | null } | { kind: "not_found" } | { kind: "indeterminate"; reason: string };

export interface ConnectionCheck { ok: boolean; status: "connected" | "expired" | "insufficient_permissions" | "error"; message: string; details?: Record<string, unknown> }

export interface PlatformAdapter {
  platform: Platform;
  publish(ctx: PublishCtx): Promise<PublishOutcome>;
  reconcile(ctx: PublishCtx): Promise<ReconcileOutcome>;
}

// ───────── Telegram ─────────
export interface TelegramCreds { bot_token: string }

const TG = "https://api.telegram.org";

interface TgResponse<T> { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } }

function classifyTg(r: TgResponse<unknown>, httpStatus: number): PublishError {
  const d = r.description ?? `HTTP ${httpStatus}`;
  if (httpStatus === 429 || r.error_code === 429) return new PublishError("rate_limit", `Telegram: ${d}`, { retryAfterSec: r.parameters?.retry_after ?? 60, httpStatus });
  if (httpStatus === 401 || r.error_code === 401) return new PublishError("auth", "Telegram: токен бота недействителен", { httpStatus });
  if (httpStatus === 403 || /not enough rights|bot is not a member|kicked|have no rights/i.test(d)) return new PublishError("permission", `Telegram: у бота нет прав публиковать в канале (${d})`, { httpStatus });
  if (/chat not found/i.test(d)) return new PublishError("permission", "Telegram: канал не найден или бот не добавлен", { httpStatus });
  if (/file|photo|video|wrong .* type|too big|IMAGE_PROCESS_FAILED|failed to get HTTP URL/i.test(d)) return new PublishError("media", `Telegram: ${d}`, { httpStatus });
  if (httpStatus >= 500) return new PublishError("unknown_result", `Telegram: ошибка сервера ${httpStatus} после отправки`, { httpStatus });
  return new PublishError("validation", `Telegram: ${d}`, { httpStatus });
}

export async function tgCall<T>(token: string, method: string, body: FormData | Record<string, unknown>, opts: { afterSendUncertain: boolean }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${TG}/bot${token}/${method}`, body instanceof FormData
      ? { method: "POST", body, signal: AbortSignal.timeout(110_000) }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    // We cannot know whether Telegram received the request.
    if (opts.afterSendUncertain) throw new PublishError("unknown_result", `Telegram: обрыв соединения (${(e as Error).name})`);
    throw new PublishError("network", `Telegram: сеть недоступна (${(e as Error).name})`, { retryable: true });
  }
  let data: TgResponse<T>;
  try { data = await res.json(); } catch {
    if (opts.afterSendUncertain && res.status >= 500) throw new PublishError("unknown_result", `Telegram: HTTP ${res.status}`);
    throw new PublishError("platform", `Telegram: некорректный ответ HTTP ${res.status}`, { retryable: !opts.afterSendUncertain });
  }
  if (!data.ok) throw classifyTg(data, res.status);
  return data.result as T;
}

function tgChatId(account: PublishCtx["account"]): string {
  const id = account.external_id ?? account.handle;
  if (!id) throw new PublishError("validation", "У аккаунта нет ID канала");
  return id;
}

function tgLink(account: PublishCtx["account"], messageId: number): string | null {
  if (account.handle?.startsWith("@")) return `https://t.me/${account.handle.slice(1)}/${messageId}`;
  const ext = account.external_id ?? "";
  if (ext.startsWith("-100")) return `https://t.me/c/${ext.slice(4)}/${messageId}`;
  return null;
}

async function fetchMedia(m: AdapterMedia): Promise<Blob> {
  try {
    const r = await fetch(m.signedUrl, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new PublishError("media", `Файл «${m.file_name}» недоступен (HTTP ${r.status})`);
    return await r.blob();
  } catch (e) {
    if (e instanceof PublishError) throw e;
    throw new PublishError("network", `Не удалось скачать «${m.file_name}» из хранилища`, { retryable: true });
  }
}

export const telegramAdapter: PlatformAdapter = {
  platform: "telegram",
  async publish(ctx) {
    const creds = ctx.credentials as TelegramCreds | null;
    if (!creds?.bot_token) throw new PublishError("auth", "Нет токена бота");
    const chat_id = tgChatId(ctx.account);
    const text = composeText(ctx.post);
    const silent = Boolean(ctx.post.platform_options?.disable_notification);

    // Prepare everything that can fail safely BEFORE the irreversible call.
    const blobs = await Promise.all(ctx.media.map(fetchMedia));
    await ctx.saveCheckpoint({ ...ctx.checkpoint, sending: true, sent_at: new Date().toISOString() });

    let messageId: number;
    if (ctx.post.format === "text") {
      const r = await tgCall<{ message_id: number }>(creds.bot_token, "sendMessage",
        { chat_id, text, disable_notification: silent, link_preview_options: { is_disabled: Boolean(ctx.post.platform_options?.disable_preview) } },
        { afterSendUncertain: true });
      messageId = r.message_id;
    } else if (ctx.post.format === "photo" || ctx.post.format === "video") {
      const m = ctx.media[0]!;
      const fd = new FormData();
      fd.set("chat_id", chat_id);
      if (text) fd.set("caption", text);
      fd.set("disable_notification", String(silent));
      const field = ctx.post.format === "photo" ? "photo" : "video";
      fd.set(field, blobs[0]!, m.file_name);
      if (field === "video") fd.set("supports_streaming", "true");
      const r = await tgCall<{ message_id: number }>(creds.bot_token, ctx.post.format === "photo" ? "sendPhoto" : "sendVideo", fd, { afterSendUncertain: true });
      messageId = r.message_id;
    } else if (ctx.post.format === "album") {
      const fd = new FormData();
      fd.set("chat_id", chat_id);
      fd.set("disable_notification", String(silent));
      const items = ctx.media.map((m, i) => {
        fd.set(`f${i}`, blobs[i]!, m.file_name);
        return { type: m.kind === "image" ? "photo" : "video", media: `attach://f${i}`, ...(i === 0 && text ? { caption: text } : {}) };
      });
      fd.set("media", JSON.stringify(items));
      const r = await tgCall<{ message_id: number }[]>(creds.bot_token, "sendMediaGroup", fd, { afterSendUncertain: true });
      messageId = r[0]!.message_id;
    } else {
      throw new PublishError("validation", `Telegram не поддерживает формат ${ctx.post.format}`);
    }
    return { kind: "published", externalId: `${chat_id}:${messageId}`, url: tgLink(ctx.account, messageId) };
  },
  // Bot API cannot read channel history → we cannot verify; humans decide.
  reconcile() {
    return Promise.resolve({ kind: "indeterminate", reason: "Bot API не позволяет проверить канал — нужна ручная проверка" });
  },
};

export async function checkTelegram(token: string, chat: string): Promise<ConnectionCheck & { chatId?: string; title?: string; username?: string; botUsername?: string }> {
  try {
    const me = await tgCall<{ id: number; username: string }>(token, "getMe", {}, { afterSendUncertain: false });
    const c = await tgCall<{ id: number; title?: string; username?: string; type: string }>(token, "getChat", { chat_id: chat }, { afterSendUncertain: false });
    if (c.type !== "channel" && c.type !== "supergroup" && c.type !== "group") {
      return { ok: false, status: "error", message: "Это не канал и не группа" };
    }
    const member = await tgCall<{ status: string; can_post_messages?: boolean }>(token, "getChatMember", { chat_id: c.id, user_id: me.id }, { afterSendUncertain: false });
    const canPost = member.status === "creator" || (member.status === "administrator" && (c.type !== "channel" || member.can_post_messages === true));
    if (!canPost) {
      return { ok: false, status: "insufficient_permissions", message: `Бот @${me.username} должен быть администратором канала с правом публикации`, chatId: String(c.id), title: c.title, username: c.username, botUsername: me.username };
    }
    return { ok: true, status: "connected", message: "Подключено", chatId: String(c.id), title: c.title, username: c.username, botUsername: me.username };
  } catch (e) {
    const pe = e instanceof PublishError ? e : new PublishError("network", String(e));
    return { ok: false, status: pe.category === "auth" ? "expired" : pe.category === "permission" ? "insufficient_permissions" : "error", message: pe.message };
  }
}

// ───────── Mock (UI/queue testing only; never counted as a real publication) ─────────
export const mockAdapter: PlatformAdapter = {
  platform: "telegram",
  async publish(ctx) {
    await ctx.saveCheckpoint({ ...ctx.checkpoint, sending: true });
    return { kind: "published", externalId: `mock:${ctx.jobId}`, url: null, isMock: true };
  },
  reconcile(ctx) {
    return Promise.resolve({ kind: "found", externalId: `mock:${ctx.jobId}`, url: null });
  },
};

export function adapterFor(platform: Platform, connectionStatus: string): PlatformAdapter | null {
  if (connectionStatus === "mock") return mockAdapter;
  if (platform === "telegram") return telegramAdapter;
  return null; // Instagram / YouTube / Threads — next iteration
}
