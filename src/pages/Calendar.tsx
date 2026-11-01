import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { CAPABILITIES, POST_STATUS_LABELS, type PostStatus } from "@domain";
import { PageHeader } from "@/components/AppShell";
import { Button, cx, PlatformIcon, Select, Spinner, StatusBadge } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { useAccounts, useBrands, usePostsRange } from "@/lib/queries";
import type { Post } from "@/lib/types";

type View = "month" | "week" | "day" | "list";
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const STATUS_DOT: Partial<Record<PostStatus, string>> = { published: "bg-emerald-500", failed: "bg-rose-500", unknown_result: "bg-amber-500", awaiting_credentials: "bg-amber-500", publishing: "bg-sky-500" };

export function CalendarPage() {
  const [view, setView] = useState<View>(() => (window.innerWidth < 640 ? "list" : "month"));
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [f, setF] = useState({ brand: "", account: "", platform: "", status: "" });
  const accounts = useAccounts().data ?? [];
  const brands = useBrands().data ?? [];
  const nav = useNavigate();

  const [from, to] = useMemo(() => {
    if (view === "month") { const s = mondayOf(new Date(cursor.getFullYear(), cursor.getMonth(), 1)); return [s, addDays(s, 42)]; }
    if (view === "week") { const s = mondayOf(cursor); return [s, addDays(s, 7)]; }
    if (view === "day") return [cursor, addDays(cursor, 1)];
    return [startOfDay(cursor), addDays(cursor, 30)];
  }, [view, cursor]);
  const { data, isLoading } = usePostsRange(from.toISOString(), to.toISOString());
  const acc = (id: string | null) => accounts.find((a) => a.id === id);

  const posts = (data ?? []).filter((p) => {
    const a = acc(p.account_id);
    return (!f.brand || p.brand_id === f.brand || a?.brand_id === f.brand) && (!f.account || p.account_id === f.account) && (!f.platform || a?.platform === f.platform) && (!f.status || p.status === f.status);
  });
  const when = (p: Post) => new Date(p.scheduled_at ?? p.published_at!);
  const byDay = new Map<string, Post[]>();
  for (const p of posts) { const k = key(when(p)); byDay.set(k, [...(byDay.get(k) ?? []), p]); }

  const shift = (dir: number) => setCursor(view === "month" ? new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1) : addDays(cursor, dir * (view === "week" ? 7 : view === "day" ? 1 : 30)));
  const title = view === "month" ? cursor.toLocaleDateString("ru-RU", { month: "long", year: "numeric" })
    : `${from.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} — ${addDays(to, -1).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" })}`;
  const newAt = (d: Date) => nav(`/posts/new?date=${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);

  const Chip = ({ p }: { p: Post }) => { const a = acc(p.account_id); return (
    <Link to={`/posts/${p.id}`} className="flex items-center gap-1 truncate rounded bg-slate-100 px-1.5 py-0.5 text-xs hover:bg-indigo-100 dark:bg-slate-800 dark:hover:bg-indigo-900" title={`${POST_STATUS_LABELS[p.status]} · ${a?.name ?? ""}`}>
      <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[p.status] ?? "bg-indigo-500")} />
      <span className="shrink-0 text-slate-500">{when(p).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>
      <span className="truncate">{p.title || p.body.slice(0, 40) || "—"}</span>
    </Link>); };

  return (
    <>
      <PageHeader title="Календарь" sub="Время показано в вашем часовом поясе" actions={<Link to="/posts/new"><Button variant="primary"><Plus className="h-4 w-4" />Материал</Button></Link>} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={() => shift(-1)} aria-label="Назад"><ChevronLeft className="h-4 w-4" /></Button>
        <Button onClick={() => setCursor(startOfDay(new Date()))}>Сегодня</Button>
        <Button variant="ghost" onClick={() => shift(1)} aria-label="Вперёд"><ChevronRight className="h-4 w-4" /></Button>
        <span className="font-semibold capitalize">{title}</span>
        <div className="ml-auto flex rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
          {(["day", "week", "month", "list"] as View[]).map((v) => <button key={v} onClick={() => setView(v)} className={cx("rounded-md px-3 py-1 text-sm", view === v && "bg-white shadow dark:bg-slate-700")}>{{ day: "День", week: "Неделя", month: "Месяц", list: "Список" }[v]}</button>)}
        </div>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Select value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })}><option value="">Все бренды</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
        <Select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })}><option value="">Все аккаунты</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
        <Select value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value })}><option value="">Все площадки</option>{Object.entries(CAPABILITIES).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}</Select>
        <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Все статусы</option>{Object.entries(POST_STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
      </div>

      {isLoading ? <Spinner /> : view === "month" ? (
        <div className="overflow-hidden rounded-xl ring-1 ring-slate-200 dark:ring-slate-800">
          <div className="grid grid-cols-7 bg-slate-100 text-center text-xs font-medium text-slate-500 dark:bg-slate-800">{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d) => <div key={d} className="py-1.5">{d}</div>)}</div>
          <div className="grid grid-cols-7">
            {Array.from({ length: 42 }, (_, i) => addDays(from, i)).map((d) => { const items = byDay.get(key(d)) ?? []; const today = key(d) === key(new Date()); return (
              <div key={d.toISOString()} className={cx("group min-h-24 border-b border-r border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-900", d.getMonth() !== cursor.getMonth() && "bg-slate-50 opacity-60 dark:bg-slate-950")}>
                <div className="flex items-center justify-between"><span className={cx("px-1 text-xs", today && "rounded-full bg-indigo-600 font-bold text-white")}>{d.getDate()}</span>
                  <button onClick={() => newAt(d)} className="hidden rounded p-0.5 text-slate-400 hover:bg-slate-100 group-hover:block dark:hover:bg-slate-800" aria-label="Создать"><Plus className="h-3 w-3" /></button></div>
                <div className="mt-1 space-y-0.5">{items.slice(0, 4).map((p) => <Chip key={p.id} p={p} />)}{items.length > 4 && <button onClick={() => { setCursor(d); setView("day"); }} className="px-1 text-xs text-indigo-600">ещё {items.length - 4}</button>}</div>
              </div>); })}
          </div>
        </div>
      ) : view === "week" ? (
        <div className="grid gap-2 md:grid-cols-7">
          {Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((d) => (
            <div key={d.toISOString()} className="min-h-40 rounded-xl bg-white p-2 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
              <div className="mb-2 flex items-center justify-between text-sm font-medium"><span className={key(d) === key(new Date()) ? "text-indigo-600" : ""}>{d.toLocaleDateString("ru-RU", { weekday: "short", day: "numeric" })}</span><button onClick={() => newAt(d)} aria-label="Создать"><Plus className="h-4 w-4 text-slate-400" /></button></div>
              <div className="space-y-1">{(byDay.get(key(d)) ?? []).map((p) => <Chip key={p.id} p={p} />)}</div>
            </div>))}
        </div>
      ) : (
        <div className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200 dark:divide-slate-800 dark:bg-slate-900 dark:ring-slate-800">
          {posts.length === 0 && <p className="p-6 text-center text-sm text-slate-500">В этом периоде публикаций нет.</p>}
          {[...posts].sort((a, b) => when(a).getTime() - when(b).getTime()).map((p) => { const a = acc(p.account_id); return (
            <Link key={p.id} to={`/posts/${p.id}`} className="flex items-center gap-3 p-3 hover:bg-slate-50 dark:hover:bg-slate-800">
              {a ? <PlatformIcon platform={a.platform} /> : <span className="h-6 w-6" />}
              <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{p.title || p.body.slice(0, 90) || "Без текста"}</div><div className="text-xs text-slate-500">{a?.name ?? "без аккаунта"} · {fmtDateTime(when(p).toISOString())}</div></div>
              <StatusBadge status={p.status} />
            </Link>); })}
        </div>
      )}
    </>
  );
}
