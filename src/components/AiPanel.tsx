import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import type { Platform } from "@domain";
import { fmtUsd } from "@/lib/format";
import { ApiError, fn } from "@/lib/supabase";
import type { Post } from "@/lib/types";
import { Badge, Button, Card, Input, Select, Textarea, useToast } from "./ui";

interface PostOut { title: string; body: string; hashtags: string[]; cta: string; media_brief: string; claims_to_verify: string[] }
type Result =
  | { kind: "post"; data: PostOut }
  | { kind: "variants"; data: PostOut[] }
  | { kind: "reel"; data: { hook: string; scenes: { from_sec: number; to_sec: number; visual: string; voiceover: string; on_screen_text: string }[]; caption: string; hashtags: string[]; cta: string } }
  | { kind: "yt"; data: { titles: { title: string; approach: string }[]; description: string; tags: string[]; chapters: { time: string; title: string }[]; hooks: string[]; thumbnail_ideas: string[]; cta: string } };

const TASKS = [
  ["generate_post", "Написать по теме"], ["rewrite", "Переписать"], ["shorten", "Сократить"], ["expand", "Расширить"], ["change_tone", "Сменить тон"],
  ["variants", "Несколько вариантов"], ["reel_script", "Сценарий Reels/Shorts"], ["youtube_metadata", "Метаданные YouTube"],
] as const;

export function AiPanel({ post, draft, platform, disabled, onApply, onSaveFirst }: {
  post: Post | null; draft: { account_id: string; brand_id: string; format: string; title: string; body: string; hashtags: string[] }; platform: Platform | null;
  disabled?: boolean; onApply: (p: { title?: string; body?: string; hashtags?: string[] }) => void; onSaveFirst: () => Promise<boolean>;
}) {
  const [task, setTask] = useState<(typeof TASKS)[number][0]>("generate_post");
  const [topic, setTopic] = useState("");
  const [tone, setTone] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [cost, setCost] = useState<number | null | undefined>(undefined);
  const toast = useToast();
  const qc = useQueryClient();

  const text = [draft.body, draft.hashtags.map((t) => `#${t}`).join(" ")].filter(Boolean).join("\n\n");
  const base = { brand_id: draft.brand_id || null, account_id: draft.account_id || null, platform, format: draft.format };

  async function run() {
    setBusy(true); setRes(null);
    try {
      const needsText = !["generate_post", "variants", "reel_script", "youtube_metadata"].includes(task);
      if (needsText && !draft.body.trim()) throw new Error("Сначала напишите текст");
      const r = await fn<{ data: unknown; costUsd: number | null }>("ai-generate", { task, ...base, topic: topic || draft.title || undefined, text: text || undefined, tone: tone || undefined, count: task === "variants" ? 3 : undefined });
      setCost(r.costUsd);
      setRes(task === "variants" ? { kind: "variants", data: (r.data as { variants: PostOut[] }).variants } : task === "reel_script" ? { kind: "reel", data: r.data as never } : task === "youtube_metadata" ? { kind: "yt", data: r.data as never } : { kind: "post", data: r.data as PostOut });
      qc.invalidateQueries({ queryKey: ["stats"] });
    } catch (e) { toast(e instanceof Error ? e.message : String(e), "err"); }
    setBusy(false);
  }

  async function check() {
    if (!(await onSaveFirst())) return;
    if (!post) { toast("Сохраните материал, затем запустите проверку", "err"); return; }
    setBusy(true);
    try {
      const r = await fn<{ data: { score: number; passed: boolean }; costUsd: number | null }>("ai-generate", { task: "quality_check", post_id: post.id });
      setCost(r.costUsd);
      toast(`Проверка: ${r.data.score}/100 — ${r.data.passed ? "можно публиковать" : "есть замечания"}`, r.data.passed ? "ok" : "err");
      qc.invalidateQueries({ queryKey: ["post"] });
    } catch (e) { toast(e instanceof ApiError ? e.message : String(e), "err"); }
    setBusy(false);
  }

  const PostView = ({ p }: { p: PostOut }) => (
    <div className="space-y-2 rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800">
      {p.title && <p className="font-medium">{p.title}</p>}
      <p className="whitespace-pre-wrap">{p.body}</p>
      {p.hashtags.length > 0 && <p className="text-indigo-600">{p.hashtags.map((h) => `#${h}`).join(" ")}</p>}
      {p.media_brief && <p className="text-xs text-slate-500">ТЗ на медиа: {p.media_brief}</p>}
      {p.claims_to_verify.length > 0 && <div className="text-xs text-amber-600">Проверьте: {p.claims_to_verify.join("; ")}</div>}
      <Button variant="primary" disabled={disabled} onClick={() => onApply({ title: p.title || undefined, body: p.cta && !p.body.includes(p.cta) ? `${p.body}\n\n${p.cta}` : p.body, hashtags: p.hashtags })}>Применить</Button>
    </div>
  );

  return (
    <Card title={<span className="flex items-center gap-1.5"><Sparkles className="h-4 w-4 text-indigo-600" />Claude</span>} actions={cost !== undefined && <Badge>{fmtUsd(cost)}</Badge>}>
      <div className="space-y-2">
        <Select value={task} onChange={(e) => setTask(e.target.value as typeof task)}>{TASKS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        {["generate_post", "variants", "reel_script", "youtube_metadata"].includes(task) && <Textarea rows={3} placeholder="Тема, тезисы, пожелания" value={topic} onChange={(e) => setTopic(e.target.value)} />}
        {task === "change_tone" && <Input placeholder="Например: дерзко и с юмором" value={tone} onChange={(e) => setTone(e.target.value)} />}
        <div className="flex gap-2"><Button variant="primary" className="flex-1" loading={busy} disabled={disabled} onClick={run}>Выполнить</Button><Button loading={busy} onClick={check} disabled={disabled}>Проверить качество</Button></div>
        {!draft.brand_id && <p className="text-xs text-slate-500">Без бренда Claude пишет нейтрально — выберите бренд для учёта тона и запретов.</p>}
      </div>
      {res?.kind === "post" && <div className="mt-3"><PostView p={res.data} /></div>}
      {res?.kind === "variants" && <div className="mt-3 space-y-3">{res.data.map((p, i) => <PostView key={i} p={p} />)}</div>}
      {res?.kind === "reel" && (
        <div className="mt-3 space-y-2 text-sm">
          <p><b>Крючок:</b> {res.data.hook}</p>
          <ol className="space-y-1.5">{res.data.scenes.map((s, i) => <li key={i} className="rounded bg-slate-50 p-2 dark:bg-slate-800"><b>{s.from_sec}–{s.to_sec} с.</b> {s.visual}<br /><span className="text-slate-500">Голос:</span> {s.voiceover}<br /><span className="text-slate-500">Текст:</span> {s.on_screen_text}</li>)}</ol>
          <Button variant="primary" disabled={disabled} onClick={() => onApply({ body: `${res.data.caption}\n\n${res.data.cta}`, hashtags: res.data.hashtags })}>Применить подпись</Button>
        </div>)}
      {res?.kind === "yt" && (
        <div className="mt-3 space-y-2 text-sm">
          <p className="font-medium">Заголовки:</p>
          {res.data.titles.map((t, i) => <button key={i} disabled={disabled} onClick={() => onApply({ title: t.title })} className="block w-full rounded bg-slate-50 p-2 text-left hover:bg-indigo-50 dark:bg-slate-800">{t.title}<span className="block text-xs text-slate-500">{t.approach}</span></button>)}
          <Button disabled={disabled} onClick={() => onApply({ body: [res.data.description, res.data.chapters.map((c) => `${c.time} ${c.title}`).join("\n")].filter(Boolean).join("\n\n"), hashtags: res.data.tags })}>Применить описание и теги</Button>
          {res.data.thumbnail_ideas.length > 0 && <p className="text-xs text-slate-500">Обложки: {res.data.thumbnail_ideas.join(" · ")}</p>}
          {res.data.hooks.length > 0 && <p className="text-xs text-slate-500">Первые секунды: {res.data.hooks.join(" · ")}</p>}
        </div>)}
    </Card>
  );
}
