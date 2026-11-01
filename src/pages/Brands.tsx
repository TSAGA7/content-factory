import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { Badge, Button, Card, Empty, errText, Input, Label, Modal, Spinner, Textarea, useToast } from "@/components/ui";
import { useAccounts, useBrands } from "@/lib/queries";
import { must, supabase } from "@/lib/supabase";
import type { Brand } from "@/lib/types";

const LIST_FIELDS = ["rubrics", "forbidden_topics", "forbidden_phrases", "required_elements", "preferred_slots", "links"] as const;
const TEXT_FIELDS: [keyof Brand, string, string?][] = [
  ["description", "Описание"], ["niche", "Ниша"], ["audience", "Аудитория", "Кто читает, что им важно"], ["positioning", "Позиционирование"],
  ["tone", "Тональность", "Например: дружелюбно, экспертно, без канцелярита"], ["style", "Стиль текстов"], ["visual_concept", "Визуальная концепция"],
  ["goals", "Цели"], ["posting_frequency", "Частота публикаций"], ["hashtag_rules", "Правила хештегов"], ["cta_rules", "Правила призывов (CTA)"],
  ["examples", "Примеры удачных публикаций"],
];
const LIST_LABELS: Record<(typeof LIST_FIELDS)[number], string> = {
  rubrics: "Рубрики", forbidden_topics: "Запрещённые темы", forbidden_phrases: "Запрещённые формулировки",
  required_elements: "Обязательные элементы", preferred_slots: "Предпочтительные слоты (например, Пн 10:00)", links: "Ссылки",
};

type Form = Record<string, string> & { name: string; color: string };
const toForm = (b?: Brand): Form => {
  const f: Form = { name: b?.name ?? "", color: b?.color ?? "#6366f1" };
  for (const [k] of TEXT_FIELDS) f[k] = (b?.[k] as string | null) ?? "";
  for (const k of LIST_FIELDS) f[k] = (b?.[k] ?? []).join("\n");
  return f;
};

export function BrandsPage() {
  const { data: brands, isLoading } = useBrands();
  const accounts = useAccounts().data ?? [];
  const [edit, setEdit] = useState<Brand | "new" | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  async function remove(b: Brand) {
    if (!confirm(`Удалить бренд «${b.name}»? Аккаунты и материалы останутся без бренда.`)) return;
    try { must(await supabase.from("brands").delete().eq("id", b.id)); qc.invalidateQueries(); toast("Бренд удалён"); } catch (e) { toast(errText(e), "err"); }
  }

  return (
    <>
      <PageHeader title="Бренды" sub="Правила и контекст, которые Claude использует при генерации" actions={<Button variant="primary" onClick={() => setEdit("new")}><Plus className="h-4 w-4" />Бренд</Button>} />
      {isLoading ? <Spinner /> : !brands?.length ? <Empty title="Брендов пока нет" text="Бренд объединяет аккаунты на разных площадках и задаёт тон, рубрики и запреты." action={<Button variant="primary" onClick={() => setEdit("new")}>Создать бренд</Button>} /> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {brands.map((b) => (
            <Card key={b.id}>
              <div className="flex items-start gap-3">
                <span className="mt-1 h-4 w-4 shrink-0 rounded-full" style={{ background: b.color }} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{b.name}</div>
                  <p className="mt-1 line-clamp-2 text-sm text-slate-500">{b.description || b.niche || "Без описания"}</p>
                  <div className="mt-2 flex flex-wrap gap-1">{b.rubrics.slice(0, 5).map((r) => <Badge key={r}>{r}</Badge>)}</div>
                  <p className="mt-2 text-xs text-slate-500">Аккаунтов: {accounts.filter((a) => a.brand_id === b.id).length}{b.forbidden_topics.length ? ` · запретов: ${b.forbidden_topics.length + b.forbidden_phrases.length}` : ""}</p>
                </div>
                <div className="flex gap-1">
                  <button className="rounded p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => setEdit(b)} aria-label="Редактировать"><Pencil className="h-4 w-4" /></button>
                  <button className="rounded p-1.5 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950" onClick={() => remove(b)} aria-label="Удалить"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
            </Card>))}
        </div>)}
      {edit && <BrandForm brand={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function BrandForm({ brand, onClose }: { brand?: Brand; onClose: () => void }) {
  const [f, setF] = useState<Form>(toForm(brand));
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const row: Record<string, unknown> = { name: f.name.trim(), color: f.color };
    for (const [k] of TEXT_FIELDS) row[k] = f[k]?.trim() || null;
    for (const k of LIST_FIELDS) row[k] = (f[k] ?? "").split(/\n|,/).map((s) => s.trim()).filter(Boolean);
    try {
      must(brand ? await supabase.from("brands").update(row).eq("id", brand.id) : await supabase.from("brands").insert(row));
      qc.invalidateQueries({ queryKey: ["brands"] }); qc.invalidateQueries({ queryKey: ["stats"] });
      toast(brand ? "Бренд сохранён" : "Бренд создан"); onClose();
    } catch (err) { toast(/duplicate|unique/.test(errText(err)) ? "Бренд с таким названием уже есть" : errText(err), "err"); }
    setBusy(false);
  }

  return (
    <Modal open onClose={onClose} title={brand ? `Бренд «${brand.name}»` : "Новый бренд"} wide>
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Label label="Название"><Input required maxLength={120} value={f.name} onChange={set("name")} /></Label>
          <Label label="Цвет"><Input type="color" className="h-10 w-20 p-1" value={f.color} onChange={set("color")} /></Label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {TEXT_FIELDS.map(([k, l, h]) => <Label key={k} label={l} hint={h}><Textarea rows={k === "examples" ? 4 : 2} value={f[k]} onChange={set(k)} /></Label>)}
          {LIST_FIELDS.map((k) => <Label key={k} label={LIST_LABELS[k]} hint="По одному на строку или через запятую"><Textarea rows={3} value={f[k]} onChange={set(k)} /></Label>)}
        </div>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Отмена</Button><Button variant="primary" loading={busy}>Сохранить</Button></div>
      </form>
    </Modal>
  );
}
