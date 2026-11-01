// Claude integration: structured output via forced tool use, prompt caching, usage accounting, budgets.
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CAPABILITIES, FORMAT_LABELS, programmaticChecks, type Platform } from "./domain.ts";
import { config, type Db, HttpError, redact } from "./edge.ts";

export const PROMPT_VERSIONS = {
  system: "sys-2026-11-01.1",
  content_plan: "plan-1", generate_post: "post-1", rewrite: "edit-1", shorten: "edit-1", expand: "edit-1",
  change_tone: "edit-1", adapt_platform: "adapt-1", variants: "var-1", quality_check: "qc-1", reel_script: "reel-1", youtube_metadata: "ytm-1",
} as const;
export type AiTask = Exclude<keyof typeof PROMPT_VERSIONS, "system">;

const postOut = z.object({
  title: z.string().describe("Заголовок (для YouTube обязателен, иначе можно пустой)"),
  body: z.string().describe("Основной текст / подпись без хештегов"),
  hashtags: z.array(z.string()).describe("Хештеги без #"),
  cta: z.string().describe("Призыв к действию, если уместен"),
  media_brief: z.string().describe("ТЗ на фото/видео для публикации"),
  claims_to_verify: z.array(z.string()).describe("Фактические утверждения, которые нужно проверить человеку"),
});

export const SCHEMAS = {
  content_plan: z.object({
    items: z.array(z.object({
      date: z.string().describe("YYYY-MM-DD"), time: z.string().describe("HH:MM в поясе аккаунта"),
      account_id: z.string(), format: z.string(), rubric: z.string(), topic: z.string(), angle: z.string(),
    })).min(1),
  }),
  generate_post: postOut, rewrite: postOut, shorten: postOut, expand: postOut, change_tone: postOut, adapt_platform: postOut,
  variants: z.object({ variants: z.array(postOut).min(2).max(5) }),
  quality_check: z.object({
    score: z.number().int().min(0).max(100), passed: z.boolean(),
    problems: z.array(z.string()), unverified_claims: z.array(z.string()), brand_fit: z.string(), suggestions: z.array(z.string()),
  }),
  reel_script: z.object({
    hook: z.string(),
    scenes: z.array(z.object({ from_sec: z.number(), to_sec: z.number(), visual: z.string(), voiceover: z.string(), on_screen_text: z.string() })),
    caption: z.string(), hashtags: z.array(z.string()), cta: z.string(),
  }),
  youtube_metadata: z.object({
    titles: z.array(z.object({ title: z.string().max(100), approach: z.string() })).min(3).max(6),
    description: z.string(), tags: z.array(z.string()), chapters: z.array(z.object({ time: z.string(), title: z.string() })),
    hooks: z.array(z.string()), thumbnail_ideas: z.array(z.string()), cta: z.string(),
  }),
} satisfies Record<AiTask, z.ZodTypeAny>;

const TASK_INSTRUCTIONS: Record<AiTask, string> = {
  content_plan: "Составь контент-план на указанный период для перечисленных аккаунтов. Равномерно распредели публикации, учитывай рубрики, частоту и предпочтительные слоты бренда, допустимые форматы площадок. Используй только переданные account_id.",
  generate_post: "Напиши публикацию по теме для указанной площадки и формата.",
  rewrite: "Перепиши текст, сохранив смысл и факты, сделай его сильнее.",
  shorten: "Сократи текст примерно вдвое, сохранив главное.",
  expand: "Расширь текст: добавь полезные детали и примеры без воды и выдуманных фактов.",
  change_tone: "Перепиши текст в указанной тональности.",
  adapt_platform: "Адаптируй материал под целевую площадку и формат: длина, структура, хештеги, призыв.",
  variants: "Дай несколько заметно разных вариантов публикации (разные подходы и крючки).",
  quality_check: "Проверь материал: соответствие бренду, запреты, ясность, крючок, призыв, ошибки, неподтверждённые утверждения. Оценка 0–100, passed=true только если материал можно публиковать без правок.",
  reel_script: "Напиши сценарий вертикального видео (Reels/Shorts) 20–60 секунд: крючок в первые 2 секунды, сцены по секундам.",
  youtube_metadata: "Подготовь метаданные YouTube: 3–6 заголовков с разными подходами (≤100 символов, без < >), описание, теги (суммарно ≤500 символов), таймкоды если есть структура, варианты первых секунд, идеи обложек, CTA.",
};

export interface Brand {
  id: string; name: string; description?: string | null; niche?: string | null; audience?: string | null; positioning?: string | null;
  tone?: string | null; style?: string | null; rubrics?: string[]; forbidden_topics?: string[]; forbidden_phrases?: string[];
  required_elements?: string[]; goals?: string | null; posting_frequency?: string | null; preferred_slots?: string[];
  hashtag_rules?: string | null; cta_rules?: string | null; examples?: string | null;
}

function brandBlock(b: Brand | null): string {
  if (!b) return "Бренд не указан. Пиши нейтрально и профессионально.";
  const L = (k: string, v: unknown) => (v && (!Array.isArray(v) || v.length) ? `${k}: ${Array.isArray(v) ? v.join("; ") : v}\n` : "");
  return `# Бренд «${b.name}»\n` + L("Описание", b.description) + L("Ниша", b.niche) + L("Аудитория", b.audience) +
    L("Позиционирование", b.positioning) + L("Тональность", b.tone) + L("Стиль", b.style) + L("Рубрики", b.rubrics) +
    L("Запрещённые темы", b.forbidden_topics) + L("Запрещённые формулировки", b.forbidden_phrases) +
    L("Обязательные элементы", b.required_elements) + L("Цели", b.goals) + L("Частота", b.posting_frequency) +
    L("Предпочтительные слоты", b.preferred_slots) + L("Правила хештегов", b.hashtag_rules) + L("Правила CTA", b.cta_rules) +
    L("Примеры удачных публикаций", b.examples);
}

const SYSTEM = `Ты — редактор контент-студии CONTENT FACTORY. Пишешь на русском, если не указано иное.
Правила: не выдумывай факты, цифры, цитаты и исследования; всё, что требует проверки, перечисляй в claims_to_verify.
Соблюдай запреты бренда и лимиты площадки. Без кликбейта, вводящего в заблуждение. Ответ — только через инструмент submit_result.`;

export function platformBlock(platform: Platform | null, format: string | null): string {
  if (!platform) return "";
  const caps = CAPABILITIES[platform];
  const formats = Object.entries(caps.formats).map(([f, r]) => `${FORMAT_LABELS[f as keyof typeof FORMAT_LABELS]} (${f}): текст до ${r!.textLimit} симв., медиа ${r!.minMedia}–${r!.maxMedia}`).join("; ");
  return `Площадка: ${caps.label}. Форматы: ${formats}.${format ? ` Целевой формат: ${format}.` : ""}`;
}

export interface Pricing { [model: string]: { input: number; output: number; cache_read?: number; cache_write?: number } } // USD per 1M tokens

async function pricing(): Promise<Pricing | null> {
  const raw = Deno.env.get("AI_PRICING_JSON");
  if (!raw) return null;
  try { return JSON.parse(raw) as Pricing; } catch { return null; }
}

export interface AiResult<T> { data: T; runId: string; usage: { input: number; output: number }; costUsd: number | null }

export async function runAi<T extends AiTask>(db: Db, ownerId: string, task: T, input: {
  brand: Brand | null; platform: Platform | null; format: string | null; payload: string; postId?: string | null;
}): Promise<AiResult<z.infer<(typeof SCHEMAS)[T]>>> {
  const apiKey = await config("ANTHROPIC_API_KEY", "anthropic_api_key");
  if (!apiKey) throw new HttpError(503, "Ключ Claude не задан: добавьте ANTHROPIC_API_KEY в Настройках → Claude", "ai_not_configured");
  const { data: settings } = await db.from("system_settings").select("ai_monthly_budget_usd, ai_model").eq("owner_id", ownerId).single();
  const model = settings?.ai_model || Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";
  const maxTokens = Number(Deno.env.get("ANTHROPIC_MAX_TOKENS") ?? (task === "content_plan" || task === "reel_script" ? 8000 : 4000));

  // Budget check BEFORE calling the model.
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const { data: spent } = await db.from("ai_runs").select("cost_usd").eq("owner_id", ownerId).gte("created_at", monthStart.toISOString());
  const total = (spent ?? []).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
  const budget = Number(settings?.ai_monthly_budget_usd ?? 0);
  const baseRun = { owner_id: ownerId, brand_id: input.brand?.id ?? null, post_id: input.postId ?? null, task, prompt_version: PROMPT_VERSIONS[task], model };
  if (budget > 0 && total >= budget) {
    await db.from("ai_runs").insert({ ...baseRun, status: "budget_exceeded", error: `Бюджет ${budget}$ исчерпан` });
    throw new HttpError(402, `Месячный бюджет Claude (${budget} $) исчерпан. Увеличьте его в Настройках.`, "budget_exceeded");
  }

  const schema = SCHEMAS[task];
  const tool = { name: "submit_result", description: "Вернуть результат", input_schema: zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" }) };
  const system = [
    { type: "text", text: `${SYSTEM}\n[prompt ${PROMPT_VERSIONS.system}]` },
    { type: "text", text: brandBlock(input.brand), cache_control: { type: "ephemeral" } },
  ];
  const userText = `${TASK_INSTRUCTIONS[task]}\n${platformBlock(input.platform, input.format)}\n\n${input.payload}`;
  const messages: { role: string; content: unknown }[] = [{ role: "user", content: userText }];

  const started = Date.now();
  let lastErr = "";
  let usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let requestId: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callAnthropic(apiKey, { model, max_tokens: maxTokens, system, messages, tools: [tool], tool_choice: { type: "tool", name: "submit_result" } });
    requestId = res.requestId;
    usage = {
      input: usage.input + (res.body.usage?.input_tokens ?? 0), output: usage.output + (res.body.usage?.output_tokens ?? 0),
      cache_read: usage.cache_read + (res.body.usage?.cache_read_input_tokens ?? 0), cache_write: usage.cache_write + (res.body.usage?.cache_creation_input_tokens ?? 0),
    };
    if (!res.ok) {
      const cost = await estimate(model, usage);
      await db.from("ai_runs").insert({ ...baseRun, status: "error", error: res.error, request_id: requestId, duration_ms: Date.now() - started,
        input_tokens: usage.input, output_tokens: usage.output, cost_usd: cost });
      throw new HttpError(res.status === 429 || res.status === 529 ? 503 : 502, res.error, res.code);
    }
    const toolUse = (res.body.content ?? []).find((c) => c.type === "tool_use") as { id: string; input: unknown } | undefined;
    const parsed = schema.safeParse(toolUse?.input);
    if (parsed.success) {
      const cost = await estimate(model, usage);
      const { data: run } = await db.from("ai_runs").insert({ ...baseRun, status: "ok", request_id: requestId, duration_ms: Date.now() - started,
        input_tokens: usage.input, output_tokens: usage.output, cache_read_tokens: usage.cache_read, cache_write_tokens: usage.cache_write, cost_usd: cost }).select("id").single();
      return { data: parsed.data as z.infer<(typeof SCHEMAS)[T]>, runId: run?.id, usage, costUsd: cost };
    }
    lastErr = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    messages.push({ role: "assistant", content: res.body.content });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse?.id ?? "x", is_error: true, content: `Ответ не прошёл проверку схемы: ${lastErr}. Исправь и вызови submit_result снова.` }] });
  }
  const cost = await estimate(model, usage);
  await db.from("ai_runs").insert({ ...baseRun, status: "invalid_output", error: lastErr, request_id: requestId, duration_ms: Date.now() - started,
    input_tokens: usage.input, output_tokens: usage.output, cost_usd: cost });
  throw new HttpError(502, `Claude вернул некорректный ответ: ${lastErr}`, "invalid_output");
}

async function estimate(model: string, u: { input: number; output: number; cache_read: number; cache_write: number }): Promise<number | null> {
  const p = (await pricing())?.[model];
  if (!p) return null;
  return (u.input * p.input + u.output * p.output + u.cache_read * (p.cache_read ?? p.input * 0.1) + u.cache_write * (p.cache_write ?? p.input * 1.25)) / 1_000_000;
}

interface AnthropicBody { content?: { type: string; id?: string; input?: unknown }[]; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; error?: { message?: string } }

async function callAnthropic(apiKey: string, payload: unknown): Promise<{ ok: boolean; status: number; body: AnthropicBody; requestId: string | null; error: string; code: string }> {
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    return { ok: false, status: 0, body: {}, requestId: null, error: `Claude недоступен: ${(e as Error).name === "TimeoutError" ? "таймаут 120 с" : "сеть"}`, code: "network" };
  }
  const body = await res.json().catch(() => ({})) as AnthropicBody;
  const requestId = res.headers.get("request-id");
  if (res.ok) return { ok: true, status: res.status, body, requestId, error: "", code: "" };
  const msg = redact(body.error?.message ?? `HTTP ${res.status}`);
  const map: Record<number, [string, string]> = {
    401: ["auth", "Ключ Claude недействителен"], 403: ["auth", "Нет доступа к модели Claude"],
    429: ["rate_limit", `Лимит запросов Claude, повторите через ${res.headers.get("retry-after") ?? "минуту"} с`], 529: ["overloaded", "Claude перегружен, повторите позже"],
  };
  const [code, text] = map[res.status] ?? [res.status >= 500 ? "server" : "bad_request", "Ошибка Claude"];
  return { ok: false, status: res.status, body, requestId, error: `${text}: ${msg}`, code };
}

export { programmaticChecks };
