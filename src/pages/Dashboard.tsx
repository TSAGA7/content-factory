import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarPlus, Plus } from "lucide-react";
import { CAPABILITIES } from "@domain";
import { PageHeader } from "@/components/AppShell";
import { Badge, Button, Card, ConnBadge, Empty, PlatformIcon, Spinner, Stat } from "@/components/ui";
import { fmtAgo, fmtDateTime, fmtUsd } from "@/lib/format";
import { useAccounts, useBrands, useStats } from "@/lib/queries";
import { must, supabase } from "@/lib/supabase";

export function Dashboard() {
  const { data: s, isLoading } = useStats();
  const accounts = useAccounts().data ?? [];
  const brands = useBrands().data ?? [];
  const events = useQuery({ queryKey: ["audit", "recent"], queryFn: async () => must(await supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(8)) as { id: number; level: string; message: string; created_at: string }[] });
  const upcoming = useQuery({ queryKey: ["posts", "upcoming"], queryFn: async () => must(await supabase.from("content_posts").select("id,title,body,scheduled_at,account_id,status").in("status", ["scheduled", "platform_scheduled"]).gte("scheduled_at", new Date().toISOString()).order("scheduled_at").limit(6)) as { id: string; title: string | null; body: string; scheduled_at: string; account_id: string }[] });

  if (isLoading || !s) return <Spinner />;
  const workerAge = s.worker_last_tick ? (Date.now() - new Date(s.worker_last_tick).getTime()) / 1000 : Infinity;
  const workerOk = workerAge < 180;
  const accName = (id: string) => accounts.find((a) => a.id === id);

  return (
    <>
      <PageHeader title="Обзор" sub="Состояние всех аккаунтов и публикаций" actions={<>
        <Link to="/posts/new"><Button variant="primary"><Plus className="h-4 w-4" />Новый материал</Button></Link>
        <Link to="/ideas"><Button><CalendarPlus className="h-4 w-4" />Контент-план</Button></Link>
      </>} />

      {accounts.length === 0 && (
        <Card className="mb-5 border-l-4 border-indigo-500">
          <p className="font-medium">С чего начать</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
            <li><Link className="text-indigo-600" to="/brands">Создайте бренд</Link> — тон, аудитория, рубрики, запреты.</li>
            <li><Link className="text-indigo-600" to="/accounts">Подключите Telegram-канал</Link> через своего бота.</li>
            <li><Link className="text-indigo-600" to="/settings">Добавьте ключ Claude</Link>, чтобы генерировать тексты и планы.</li>
          </ol>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Аккаунты" value={`${s.accounts_connected} / ${s.accounts_total}`} hint={s.accounts_problem ? <span className="text-rose-600">{s.accounts_problem} с проблемами</span> : "подключено / всего"} />
        <Stat label="Активные бренды" value={s.brands_active} />
        <Stat label="Публикации сегодня" value={s.posts_today} hint={`${s.posts_7d} запланировано на 7 дней`} />
        <Stat label="Ждут утверждения" value={s.review_required} hint={`${s.drafts} черновиков`} />
        <Stat label="Очередь" value={s.jobs_queued} hint={s.jobs_blocked ? <span className="text-amber-600">{s.jobs_blocked} заблокировано</span> : "задач в работе"} />
        <Stat label="Опубликовано" value={s.published_total} hint={`${s.published_30d} за 30 дней`} />
        <Stat label="Ошибки и проверки" value={s.failed} tone={s.failed ? "rose" : undefined} hint="ошибка или нужен ручной ответ" />
        <Stat label="Claude за месяц" value={fmtUsd(s.ai_cost_month)} hint={`${s.ai_runs_month} запросов${s.ai_unpriced_month ? `, ${s.ai_unpriced_month} без цены` : ""}`} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Card title="Фоновый worker">
          <div className="flex items-center gap-2">
            <span className={`h-3 w-3 rounded-full ${workerOk ? "bg-emerald-500" : "bg-rose-500"}`} />
            <span className="font-medium">{workerOk ? "Работает" : s.worker_last_tick ? "Не отвечает" : "Ещё не запускался"}</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">Последний тик: {fmtAgo(s.worker_last_tick)}. Запуск каждую минуту через pg_cron — публикации идут при закрытом браузере.</p>
          {s.jobs_overdue > 0 && <p className="mt-2 flex items-center gap-1 text-sm text-amber-600"><AlertTriangle className="h-4 w-4" />Просроченных задач: {s.jobs_overdue}</p>}
        </Card>

        <Card title="Ближайшие публикации" className="lg:col-span-2" actions={<Link to="/calendar" className="text-sm text-indigo-600">Календарь →</Link>}>
          {(upcoming.data ?? []).length === 0 ? <p className="text-sm text-slate-500">Ничего не запланировано.</p> : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {upcoming.data!.map((p) => { const a = accName(p.account_id); return (
                <li key={p.id}><Link to={`/posts/${p.id}`} className="flex items-center gap-3 py-2 text-sm">
                  {a && <PlatformIcon platform={a.platform} />}
                  <span className="min-w-0 flex-1 truncate">{p.title || p.body.slice(0, 80) || "Без текста"}</span>
                  <span className="shrink-0 text-slate-500">{fmtDateTime(p.scheduled_at)}</span>
                </Link></li>); })}
            </ul>)}
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title="Аккаунты" actions={<Link to="/accounts" className="text-sm text-indigo-600">Все →</Link>}>
          {accounts.length === 0 ? <Empty title="Нет аккаунтов" action={<Link to="/accounts"><Button variant="primary">Подключить</Button></Link>} /> : (
            <ul className="space-y-2">
              {accounts.slice(0, 8).map((a) => (
                <li key={a.id} className="flex items-center gap-3 text-sm">
                  <PlatformIcon platform={a.platform} />
                  <div className="min-w-0 flex-1"><div className="truncate font-medium">{a.name}</div><div className="text-xs text-slate-500">{brands.find((b) => b.id === a.brand_id)?.name ?? "Без бренда"} · {CAPABILITIES[a.platform].label}</div></div>
                  {a.is_paused && <Badge>Пауза</Badge>}<ConnBadge status={a.connection_status} />
                </li>))}
            </ul>)}
        </Card>
        <Card title="Последние события" actions={<Link to="/journal" className="text-sm text-indigo-600">Журнал →</Link>}>
          {(events.data ?? []).length === 0 ? <p className="text-sm text-slate-500">Событий пока нет.</p> : (
            <ul className="space-y-2 text-sm">
              {events.data!.map((e) => <li key={e.id} className="flex gap-2"><span className={e.level === "error" ? "text-rose-600" : e.level === "warn" ? "text-amber-600" : "text-slate-400"}>●</span><span className="min-w-0 flex-1">{e.message}</span><span className="shrink-0 text-xs text-slate-500">{fmtAgo(e.created_at)}</span></li>)}
            </ul>)}
        </Card>
      </div>
    </>
  );
}
