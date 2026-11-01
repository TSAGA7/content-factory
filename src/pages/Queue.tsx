import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/AppShell";
import { Badge, Empty, PlatformIcon, Select, Spinner } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { useAccounts } from "@/lib/queries";
import { must, supabase } from "@/lib/supabase";
import type { Job } from "@/lib/types";

const LABEL: Record<string, [string, "slate" | "sky" | "amber" | "green" | "rose"]> = {
  queued: ["В очереди", "sky"], running: ["Выполняется", "sky"], continuing: ["Продолжается", "sky"], retry_wait: ["Ждёт повтора", "amber"],
  reconcile: ["Сверка", "amber"], blocked: ["Заблокирована", "amber"], succeeded: ["Готово", "green"], failed: ["Ошибка", "rose"], cancelled: ["Отменена", "slate"],
};

export function QueuePage() {
  const [status, setStatus] = useState("active");
  const accounts = useAccounts().data ?? [];
  const { data, isLoading } = useQuery({
    queryKey: ["jobs", status], refetchInterval: 15_000,
    queryFn: async () => {
      let q = supabase.from("publishing_jobs").select("*").order("run_at", { ascending: status === "active" }).limit(200);
      if (status === "active") q = q.in("status", ["queued", "running", "continuing", "retry_wait", "reconcile", "blocked"]);
      else if (status) q = q.eq("status", status);
      return must(await q) as Job[];
    },
  });
  return (
    <>
      <PageHeader title="Очередь публикаций" sub="Задачи выполняет фоновый worker раз в минуту" />
      <Select className="mb-4 max-w-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="active">Активные</option><option value="succeeded">Готовые</option><option value="failed">С ошибкой</option><option value="cancelled">Отменённые</option><option value="">Все</option>
      </Select>
      {isLoading ? <Spinner /> : !data?.length ? <Empty title="Задач нет" /> : (
        <div className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200 dark:divide-slate-800 dark:bg-slate-900 dark:ring-slate-800">
          {data.map((j) => { const a = accounts.find((x) => x.id === j.account_id); const [l, t] = LABEL[j.status] ?? [j.status, "slate"]; return (
            <Link key={j.id} to={`/posts/${j.post_id}`} className="flex items-center gap-3 p-3 hover:bg-slate-50 dark:hover:bg-slate-800">
              <PlatformIcon platform={j.platform} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{a?.name ?? "—"} · {fmtDateTime(j.run_at)}</div>
                <div className="text-xs text-slate-500">попыток {j.attempts}/{j.max_attempts} · фаза {j.phase}{j.finished_at ? ` · завершена ${fmtDateTime(j.finished_at)}` : ""}</div>
                {j.last_error && <div className="truncate text-xs text-rose-600">{j.last_error}</div>}
              </div>
              <Badge tone={t}>{l}</Badge>
            </Link>); })}
        </div>)}
    </>
  );
}
