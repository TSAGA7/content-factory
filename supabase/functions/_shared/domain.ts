// Domain layer shared by the frontend, Edge Functions and tests. No I/O here.
import { z } from "zod";

export type Platform = "telegram" | "instagram" | "youtube" | "threads";
export type PostFormat = "text" | "photo" | "video" | "album" | "carousel" | "reel" | "story" | "short" | "long_video" | "thread";
export type PostStatus = "draft" | "generated" | "review_required" | "approved" | "scheduled" | "publishing" | "platform_scheduled"
  | "published" | "unknown_result" | "awaiting_credentials" | "failed" | "paused" | "cancelled";

export interface MediaInfo {
  id: string;
  kind: "image" | "video";
  mime_type: string;
  size_bytes: number;
  width?: number | null;
  height?: number | null;
  duration_sec?: number | null;
  status?: string;
}

export interface FormatRule {
  minMedia: number;
  maxMedia: number;
  mediaKinds: ("image" | "video")[];
  textLimit: number;
}

export interface PlatformCapabilities {
  label: string;
  formats: Partial<Record<PostFormat, FormatRule>>;
  maxFileBytes: number;
  imageMimes: string[];
  videoMimes: string[];
  nativeScheduling: boolean;
  /** Publishing implemented in this build. */
  publishingReady: boolean;
}

const MB = 1024 * 1024;

export const CAPABILITIES: Record<Platform, PlatformCapabilities> = {
  telegram: {
    label: "Telegram",
    formats: {
      text: { minMedia: 0, maxMedia: 0, mediaKinds: [], textLimit: 4096 },
      photo: { minMedia: 1, maxMedia: 1, mediaKinds: ["image"], textLimit: 1024 },
      video: { minMedia: 1, maxMedia: 1, mediaKinds: ["video"], textLimit: 1024 },
      album: { minMedia: 2, maxMedia: 10, mediaKinds: ["image", "video"], textLimit: 1024 },
    },
    maxFileBytes: 50 * MB,
    imageMimes: ["image/jpeg", "image/png", "image/webp"],
    videoMimes: ["video/mp4", "video/quicktime", "video/webm"],
    nativeScheduling: false,
    publishingReady: true,
  },
  instagram: {
    label: "Instagram",
    formats: {
      photo: { minMedia: 1, maxMedia: 1, mediaKinds: ["image"], textLimit: 2200 },
      carousel: { minMedia: 2, maxMedia: 20, mediaKinds: ["image", "video"], textLimit: 2200 },
      reel: { minMedia: 1, maxMedia: 1, mediaKinds: ["video"], textLimit: 2200 },
      story: { minMedia: 1, maxMedia: 1, mediaKinds: ["image", "video"], textLimit: 0 },
    },
    maxFileBytes: 300 * MB,
    imageMimes: ["image/jpeg"],
    videoMimes: ["video/mp4", "video/quicktime"],
    nativeScheduling: false,
    publishingReady: false,
  },
  youtube: {
    label: "YouTube",
    formats: {
      short: { minMedia: 1, maxMedia: 1, mediaKinds: ["video"], textLimit: 5000 },
      long_video: { minMedia: 1, maxMedia: 1, mediaKinds: ["video"], textLimit: 5000 },
    },
    maxFileBytes: 5 * 1024 * MB,
    imageMimes: ["image/jpeg", "image/png"],
    videoMimes: ["video/mp4", "video/quicktime", "video/webm"],
    nativeScheduling: true,
    publishingReady: false,
  },
  threads: {
    label: "Threads",
    formats: {
      text: { minMedia: 0, maxMedia: 0, mediaKinds: [], textLimit: 500 },
      photo: { minMedia: 1, maxMedia: 1, mediaKinds: ["image"], textLimit: 500 },
      video: { minMedia: 1, maxMedia: 1, mediaKinds: ["video"], textLimit: 500 },
      carousel: { minMedia: 2, maxMedia: 20, mediaKinds: ["image", "video"], textLimit: 500 },
      thread: { minMedia: 0, maxMedia: 0, mediaKinds: [], textLimit: 500 },
    },
    maxFileBytes: 1024 * MB,
    imageMimes: ["image/jpeg", "image/png"],
    videoMimes: ["video/mp4", "video/quicktime"],
    nativeScheduling: false,
    publishingReady: false,
  },
};

export const FORMAT_LABELS: Record<PostFormat, string> = {
  text: "Текст", photo: "Фото", video: "Видео", album: "Альбом", carousel: "Карусель", reel: "Reels",
  story: "Stories", short: "Shorts", long_video: "Видео YouTube", thread: "Цепочка",
};

export interface ValidationIssue { field: string; message: string; severity: "error" | "warning" }

export interface ValidatablePost {
  format: PostFormat;
  title?: string | null;
  body: string;
  hashtags?: string[];
}

/** Compose final text as it will be sent (body + hashtags). */
export function composeText(post: ValidatablePost): string {
  const tags = (post.hashtags ?? []).map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ");
  return [post.body.trim(), tags].filter(Boolean).join("\n\n");
}

export function validatePostForPlatform(platform: Platform, post: ValidatablePost, media: MediaInfo[]): ValidationIssue[] {
  const caps = CAPABILITIES[platform];
  const issues: ValidationIssue[] = [];
  const rule = caps.formats[post.format];
  if (!rule) {
    issues.push({ field: "format", message: `${caps.label} не поддерживает формат «${FORMAT_LABELS[post.format]}»`, severity: "error" });
    return issues;
  }
  const text = composeText(post);
  if (post.format === "text" && !text.trim()) issues.push({ field: "body", message: "Пустой текст", severity: "error" });
  if (rule.textLimit > 0 && text.length > rule.textLimit) {
    issues.push({ field: "body", message: `Текст ${text.length} символов — лимит ${caps.label} ${rule.textLimit}`, severity: "error" });
  }
  if (rule.textLimit === 0 && post.body.trim()) {
    issues.push({ field: "body", message: "Подпись в этом формате не публикуется", severity: "warning" });
  }
  if (media.length < rule.minMedia) issues.push({ field: "media", message: `Нужно медиа: минимум ${rule.minMedia}`, severity: "error" });
  if (media.length > rule.maxMedia) issues.push({ field: "media", message: `Слишком много медиа: максимум ${rule.maxMedia}`, severity: "error" });
  for (const m of media) {
    if (m.status === "missing") issues.push({ field: "media", message: "Файл недоступен в хранилище", severity: "error" });
    if (!rule.mediaKinds.includes(m.kind)) issues.push({ field: "media", message: `Тип «${m.kind}» не подходит для формата`, severity: "error" });
    const mimes = m.kind === "image" ? caps.imageMimes : caps.videoMimes;
    if (!mimes.includes(m.mime_type)) issues.push({ field: "media", message: `${caps.label}: формат файла ${m.mime_type} не поддерживается`, severity: "error" });
    if (m.size_bytes > caps.maxFileBytes) issues.push({ field: "media", message: `Файл больше ${Math.round(caps.maxFileBytes / MB)} МБ`, severity: "error" });
  }
  if (platform === "youtube") {
    if (!post.title?.trim()) issues.push({ field: "title", message: "Нужен заголовок видео", severity: "error" });
    if ((post.title ?? "").length > 100) issues.push({ field: "title", message: "Заголовок длиннее 100 символов", severity: "error" });
    if (/[<>]/.test(post.title ?? "")) issues.push({ field: "title", message: "Заголовок не может содержать < >", severity: "error" });
    if (post.format === "short") {
      const v = media[0];
      if (v?.duration_sec && v.duration_sec > 180) issues.push({ field: "media", message: "Shorts — не длиннее 180 с", severity: "error" });
      if (v?.width && v?.height && v.width > v.height) issues.push({ field: "media", message: "Shorts должен быть вертикальным или квадратным", severity: "error" });
    }
  }
  if (!caps.publishingReady) {
    issues.push({ field: "account", message: `Публикация в ${caps.label} ещё не подключена в этой версии`, severity: "error" });
  }
  return issues;
}

// ───────── automation rules ─────────
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const automationRulesSchema = z.object({
  mode: z.enum(["manual", "approval", "limited", "extended"]).default("approval"),
  allowedFormats: z.array(z.string()).default([]),
  manualApprovalFormats: z.array(z.string()).default([]),
  maxPerDay: z.number().int().min(0).max(100).default(5),
  maxPerWeek: z.number().int().min(0).max(700).default(30),
  minIntervalMinutes: z.number().int().min(0).max(10080).default(60),
  timeWindows: z.array(z.object({ days: z.array(z.number().int().min(1).max(7)).min(1), from: hhmm, to: hhmm })).default([]),
  blackoutDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  monthlyAiBudgetUsd: z.number().min(0).max(10000).default(10),
  requireQualityPass: z.boolean().default(true),
  minQualityScore: z.number().int().min(0).max(100).default(70),
  onError: z.enum(["retry", "pause_account", "notify_only"]).default("retry"),
  pauseAfterConsecutiveFailures: z.number().int().min(1).max(50).default(3),
  autoGenerate: z.object({ enabled: z.boolean().default(false), horizonDays: z.number().int().min(1).max(30).default(7) }).default({}),
});
export type AutomationRules = z.infer<typeof automationRulesSchema>;
export const DEFAULT_RULES: AutomationRules = automationRulesSchema.parse({});

/** Invalid rules are treated as manual mode (safe default). */
export function parseRules(raw: unknown): AutomationRules {
  const r = automationRulesSchema.safeParse(raw ?? {});
  return r.success ? r.data : { ...DEFAULT_RULES, mode: "manual" };
}

export const MODE_LABELS: Record<AutomationRules["mode"], string> = {
  manual: "Ручной", approval: "Подтверждение", limited: "Ограниченный автопилот", extended: "Расширенный автопилот",
};

export function canAutoApprove(rules: AutomationRules, post: { format: PostFormat; quality_passed?: boolean | null; quality_score?: number | null }): boolean {
  if (rules.mode !== "limited" && rules.mode !== "extended") return false;
  if (!rules.allowedFormats.includes(post.format)) return false;
  if (rules.manualApprovalFormats.includes(post.format)) return false;
  if (rules.requireQualityPass && !post.quality_passed) return false;
  if ((post.quality_score ?? 0) < rules.minQualityScore) return false;
  return true;
}

// ───────── time & windows ─────────
export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number /*1=Mon..7*/ }

export function localParts(d: Date, tz: string): LocalParts {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday!) + 1;
  return { year: +p.year!, month: +p.month!, day: +p.day!, hour: +p.hour!, minute: +p.minute!, weekday: wd };
}

export function localDateKey(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Convert wall-clock time in tz to UTC Date. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = asUtc - Date.UTC(year, month - 1, day, hour, minute);
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

const toMin = (s: string) => +s.slice(0, 2) * 60 + +s.slice(3, 5);

export function isAllowedTime(rules: AutomationRules, d: Date, tz: string): boolean {
  if (rules.blackoutDates.includes(localDateKey(d, tz))) return false;
  if (rules.timeWindows.length === 0) return true;
  const p = localParts(d, tz);
  const m = p.hour * 60 + p.minute;
  return rules.timeWindows.some((w) => w.days.includes(p.weekday) && m >= toMin(w.from) && m < toMin(w.to));
}

/** Earliest allowed instant ≥ from (minute resolution, searches up to 30 days). */
export function nextAllowedTime(rules: AutomationRules, from: Date, tz: string): Date | null {
  const t = new Date(Math.ceil(from.getTime() / 60000) * 60000);
  for (let i = 0; i < 30 * 24 * 60; i += 5) {
    const c = new Date(t.getTime() + i * 60000);
    if (isAllowedTime(rules, c, tz)) return c;
  }
  return null;
}

export interface PublishContext {
  now: Date;
  tz: string;
  publishedToday: number;
  publishedThisWeek: number;
  lastPublishedAt: Date | null;
}

export type PublishDecision = { ok: true } | { ok: false; reason: string; retryAt: Date | null };

/** Server-side rule check before every publish. Window/limit violations defer without spending an attempt. */
export function evaluatePublish(rules: AutomationRules, post: { approved_by: string | null }, ctx: PublishContext): PublishDecision {
  if (!post.approved_by) return { ok: false, reason: "Материал не утверждён", retryAt: null };
  if (post.approved_by === "autopilot" && rules.mode !== "limited" && rules.mode !== "extended") {
    return { ok: false, reason: `Режим «${MODE_LABELS[rules.mode]}» не разрешает автопубликацию`, retryAt: null };
  }
  if (!isAllowedTime(rules, ctx.now, ctx.tz)) {
    return { ok: false, reason: "Вне разрешённого окна публикаций", retryAt: nextAllowedTime(rules, ctx.now, ctx.tz) };
  }
  if (rules.maxPerDay > 0 && ctx.publishedToday >= rules.maxPerDay) {
    const p = localParts(ctx.now, ctx.tz);
    const tomorrow = zonedToUtc(p.year, p.month, p.day + 1, 0, 0, ctx.tz);
    return { ok: false, reason: `Достигнут дневной лимит (${rules.maxPerDay})`, retryAt: nextAllowedTime(rules, tomorrow, ctx.tz) };
  }
  if (rules.maxPerWeek > 0 && ctx.publishedThisWeek >= rules.maxPerWeek) {
    return { ok: false, reason: `Достигнут недельный лимит (${rules.maxPerWeek})`, retryAt: new Date(ctx.now.getTime() + 24 * 3600_000) };
  }
  if (ctx.lastPublishedAt && rules.minIntervalMinutes > 0) {
    const next = new Date(ctx.lastPublishedAt.getTime() + rules.minIntervalMinutes * 60000);
    if (next > ctx.now) return { ok: false, reason: `Минимальный интервал ${rules.minIntervalMinutes} мин`, retryAt: nextAllowedTime(rules, next, ctx.tz) };
  }
  return { ok: true };
}

// ───────── errors & retries ─────────
export type ErrorCategory = "network" | "platform" | "rate_limit" | "quota" | "auth" | "permission" | "validation" | "media" | "unknown_result";

export class PublishError extends Error {
  constructor(public category: ErrorCategory, message: string, public opts: { retryable?: boolean; retryAfterSec?: number; httpStatus?: number } = {}) {
    super(message);
  }
}

export function backoffMs(attempt: number, rand = Math.random): number {
  const base = 60_000 * 2 ** Math.max(0, attempt - 1);
  return Math.round(base * (0.8 + rand() * 0.4));
}

export const POST_STATUS_LABELS: Record<PostStatus, string> = {
  draft: "Черновик", generated: "Сгенерировано", review_required: "На проверке", approved: "Утверждено",
  scheduled: "Запланировано", publishing: "Публикуется", platform_scheduled: "Запланировано на площадке",
  published: "Опубликовано", unknown_result: "Нужна проверка", awaiting_credentials: "Ждёт авторизации",
  failed: "Ошибка", paused: "На паузе", cancelled: "Отменено",
};

// ───────── programmatic quality checks ─────────
function shingles(s: string, n = 3): Set<string> {
  const w = s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}
export function jaccard(a: string, b: string): number {
  const A = shingles(a), B = shingles(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function programmaticChecks(text: string, brand: { forbidden_topics?: string[]; forbidden_phrases?: string[] } | null, recent: string[]): string[] {
  const problems: string[] = [];
  const low = text.toLowerCase();
  for (const p of [...(brand?.forbidden_phrases ?? []), ...(brand?.forbidden_topics ?? [])]) {
    if (p.trim() && low.includes(p.toLowerCase().trim())) problems.push(`Запрещённая тема/фраза бренда: «${p}»`);
  }
  for (const r of recent) {
    if (jaccard(text, r) >= 0.5) { problems.push("Слишком похоже на недавнюю публикацию"); break; }
  }
  return problems;
}
