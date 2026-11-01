import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import { FORMAT_LABELS } from "@domain";
import { PageHeader } from "@/components/AppShell";
import { Badge, Button, Empty, errText, Input, Label, Modal, PlatformIcon, Select, Spinner, Textarea, useToast } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { useAccounts, useBrands, useIdeas } from "@/lib/queries";
import { fn, must, supabase } from "@/lib/supabase";

const today = () => new Date().toISOString().slice(0, 10);
const plus = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

export function IdeasPage() {
  const { data: ideas, isLoading } = useIdeas();
  const accounts = useAccounts().data ?? [];
  const brands = useBrands().data ?? [];
  const [plan, setPlan] = useState(false);
  const [add, setAdd] = useState(false);
  const [status, setStatus] = useState("new");
  const qc = useQueryClient();
  const toast = useToast();
  const list = (ideas ?? []).filter((i) => !status || i.status === status);

  async function reject(id: string) {
    try { must(await supabase.from("content_ideas").update({ status: "rejected" }).eq("id", id)); qc.invalidateQueries({ queryKey: ["ideas"] }); } catch (e) { toast(errText(e), "err"); }
  }

  return (
    <>
      <PageHeader title="Идеи и контент-план" sub="Claude составляет план, вы превращаете идеи в материалы" actions={<>
        <Button variant="primary" onClick={() => setPlan(true)}><Sparkles className="h-4 w-4" />Составить план</Button>
        <Button onClick={() => setAdd(true)}><Plus className="h-4 w-4" />Идея</Button>
      </>} />
      <div className="mb-3 flex gap-2"><Select className="max-w-xs" value={status} onChange={(e) => setStatus(e.target.value)}><option value="new">Новые</option><option value="used">В работе</option><option value="rejected">Отклонённые</option><option value="">Все</option></Select></div>
      {isLoading ? <Spinner /> : !list.length ? <Empty title="Идей нет" text="Сгенерируйте контент-план на неделю или месяц для нескольких аккаунтов." /> : (
        <div className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200 dark:divide-slate-800 dark:bg-slate-900 dark:ring-slate-800">
          {list.map((i) => { const a = accounts.find((x) => x.id === i.account_id); return (
            <div key={i.id} className="flex items-start gap-3 p-3">
              {a ? <PlatformIcon platform={a.platform} /> : <span className="h-6 w-6" />}
              <div className="min-w-0 flex-1">
                <div className="font-medium">{i.title}</div>
                {i.angle && <p className="text-sm text-slate-500">{i.angle}</p>}
                <div className="mt-1 flex flex-wrap gap-1 text-xs">{i.planned_at && <Badge tone="sky">{fmtDateTime(i.planned_at, a?.timezone)}</Badge>}{a && <Badge>{a.name}</Badge>}{i.format && <Badge>{FORMAT_LABELS[i.format]}</Badge>}{i.rubric && <Badge tone="indigo">{i.rubric}</Badge>}{i.source === "ai_plan" && <Badge tone="green">Claude</Badge>}</div>
              </div>
              <div className="flex shrink-0 gap-1">
                {i.post_id ? <Link to={`/posts/${i.post_id}`}><Button>Открыть</Button></Link> : <Link to={`/posts/new?idea=${i.id}${i.planned_at ? `&date=${i.planned_at.slice(0, 10)}` : ""}`}><Button variant="primary">В работу</Button></Link>}
                {i.status === "new" && <Button variant="ghost" onClick={() => reject(i.id)} aria-label="Отклонить"><Trash2 className="h-4 w-4" /></Button>}
              </div>
            </div>); })}
        </div>)}
      {plan && <PlanModal onClose={() => setPlan(false)} />}
      {add && <AddIdea brands={brands} accounts={accounts} onClose={() => setAdd(false)} />}
    </>
  );
}

function PlanModal({ onClose }: { onClose: () => void }) {
  const accounts = useAccounts().data ?? [];
  const brands = useBrands().data ?? [];
  const [f, setF] = useState({ from: today(), to: plus(7), per_week: 3, brand_id: "", notes: "" });
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const visible = accounts.filter((a) => !f.brand_id || a.brand_id === f.brand_id);
  async function go() {
    setBusy(true);
    try {
      const r = await fn<{ created: number; skipped: number }>("ai-generate", { task: "content_plan", brand_id: f.brand_id || null, account_ids: ids, period: { from: f.from, to: f.to }, per_week: f.per_week, notes: f.notes || undefined });
      toast(`Создано идей: ${r.created}${r.skipped ? ` (отброшено ${r.skipped})` : ""}`);
      qc.invalidateQueries({ queryKey: ["ideas"] }); qc.invalidateQueries({ queryKey: ["stats"] });
      onClose();
    } catch (e) { toast(errText(e), "err"); }
    setBusy(false);
  }
  return (
    <Modal open onClose={onClose} title="Контент-план через Claude">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Label label="С"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Label>
          <Label label="По"><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Label label="Бренд"><Select value={f.brand_id} onChange={(e) => { setF({ ...f, brand_id: e.target.value }); setIds([]); }}><option value="">Любой</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Label>
          <Label label="Постов в неделю на аккаунт"><Input type="number" min={1} max={50} value={f.per_week} onChange={(e) => setF({ ...f, per_week: +e.target.value })} /></Label>
        </div>
        <Label label="Аккаунты"><div className="max-h-48 space-y-1 overflow-y-auto rounded-lg p-1 ring-1 ring-slate-200 dark:ring-slate-700">{visible.length === 0 ? <p className="p-2 text-sm text-slate-500">Нет аккаунтов</p> : visible.map((a) => <label key={a.id} className="flex items-center gap-2 p-1 text-sm"><input type="checkbox" checked={ids.includes(a.id)} onChange={() => setIds(ids.includes(a.id) ? ids.filter((x) => x !== a.id) : [...ids, a.id])} /><PlatformIcon platform={a.platform} />{a.name}</label>)}</div></Label>
        <Label label="Пожелания"><Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Акцент на кейсах, запуск продукта 15-го…" /></Label>
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Отмена</Button><Button variant="primary" disabled={!ids.length} loading={busy} onClick={go}><Sparkles className="h-4 w-4" />Сгенерировать</Button></div>
      </div>
    </Modal>
  );
}

function AddIdea({ brands, accounts, onClose }: { brands: { id: string; name: string }[]; accounts: { id: string; name: string }[]; onClose: () => void }) {
  const [f, setF] = useState({ title: "", angle: "", brand_id: "", account_id: "" });
  const qc = useQueryClient();
  const toast = useToast();
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try { must(await supabase.from("content_ideas").insert({ title: f.title, angle: f.angle || null, brand_id: f.brand_id || null, account_id: f.account_id || null })); qc.invalidateQueries({ queryKey: ["ideas"] }); onClose(); }
    catch (err) { toast(errText(err), "err"); }
  }
  return (
    <Modal open onClose={onClose} title="Новая идея">
      <form onSubmit={save} className="space-y-3">
        <Label label="Тема"><Input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Label>
        <Label label="Угол подачи"><Textarea rows={2} value={f.angle} onChange={(e) => setF({ ...f, angle: e.target.value })} /></Label>
        <div className="grid grid-cols-2 gap-3">
          <Label label="Бренд"><Select value={f.brand_id} onChange={(e) => setF({ ...f, brand_id: e.target.value })}><option value="">—</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Label>
          <Label label="Аккаунт"><Select value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}><option value="">—</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Label>
        </div>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Отмена</Button><Button variant="primary">Добавить</Button></div>
      </form>
    </Modal>
  );
}

