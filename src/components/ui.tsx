import { createContext, useCallback, useContext, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Loader2, X } from "lucide-react";
import { POST_STATUS_LABELS, type Platform, type PostStatus } from "@domain";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "ghost" | "danger";
export function Button({ variant = "secondary", loading, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  const v: Record<Variant, string> = {
    primary: "bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-400",
    secondary: "bg-white text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600 dark:hover:bg-slate-700",
    ghost: "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
    danger: "bg-rose-600 text-white hover:bg-rose-500",
  };
  return (
    <button {...p} disabled={p.disabled || loading}
      className={cx("inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60", v[variant], className)}>
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}{children}
    </button>
  );
}

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx("rounded-xl bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800", className)}>
      {(title || actions) && <div className="mb-3 flex items-center justify-between gap-2"><h2 className="font-semibold">{title}</h2><div className="flex gap-2">{actions}</div></div>}
      {children}
    </section>
  );
}

const field = "w-full rounded-lg border-0 bg-white px-3 py-2 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-indigo-500 dark:bg-slate-800 dark:ring-slate-600";
export function Label({ label, hint, children, error }: { label: string; hint?: string; children: ReactNode; error?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-slate-500">{hint}</span>}
      {error && <span className="block text-xs text-rose-600">{error}</span>}
    </label>
  );
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(field, p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(field, "min-h-24", p.className)} />;
export const Select = ({ children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(field, p.className)}>{children}</select>;

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "green" | "amber" | "rose" | "indigo" | "sky" }) {
  const t = {
    slate: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
    rose: "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300",
    indigo: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-300",
    sky: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300",
  }[tone];
  return <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", t)}>{children}</span>;
}

const STATUS_TONE: Record<PostStatus, "slate" | "green" | "amber" | "rose" | "indigo" | "sky"> = {
  draft: "slate", generated: "slate", review_required: "amber", approved: "indigo", scheduled: "sky", publishing: "sky",
  platform_scheduled: "sky", published: "green", unknown_result: "amber", awaiting_credentials: "amber", failed: "rose", paused: "slate", cancelled: "slate",
};
export const StatusBadge = ({ status }: { status: PostStatus }) => <Badge tone={STATUS_TONE[status]}>{POST_STATUS_LABELS[status]}</Badge>;

const CONN: Record<string, [string, "green" | "amber" | "rose" | "slate" | "indigo"]> = {
  connected: ["Подключён", "green"], mock: ["Тестовый (mock)", "indigo"], pending: ["Не подключён", "slate"], expired: ["Токен истёк", "rose"],
  insufficient_permissions: ["Нет прав", "amber"], revoked: ["Отключён", "slate"], error: ["Ошибка", "rose"], paused: ["Пауза", "slate"],
};
export const ConnBadge = ({ status }: { status: string }) => { const [l, t] = CONN[status] ?? [status, "slate"]; return <Badge tone={t}>{l}</Badge>; };

const PCOLOR: Record<Platform, string> = { telegram: "bg-sky-500", instagram: "bg-pink-500", youtube: "bg-red-600", threads: "bg-slate-900 dark:bg-slate-200 dark:text-slate-900" };
const PLETTER: Record<Platform, string> = { telegram: "TG", instagram: "IG", youtube: "YT", threads: "@" };
export const PlatformIcon = ({ platform, className }: { platform: Platform; className?: string }) =>
  <span title={platform} className={cx("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-bold text-white", PCOLOR[platform], className)}>{PLETTER[platform]}</span>;

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx("max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl dark:bg-slate-900 sm:rounded-2xl", wide ? "max-w-3xl" : "max-w-lg")}>
        <div className="mb-4 flex items-center justify-between"><h3 className="text-lg font-semibold">{title}</h3><button onClick={onClose} className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Закрыть"><X className="h-5 w-5" /></button></div>
        {children}
      </div>
    </div>
  );
}

export const Empty = ({ title, text, action }: { title: string; text?: string; action?: ReactNode }) => (
  <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
    <p className="font-medium">{title}</p>{text && <p className="mt-1 text-sm text-slate-500">{text}</p>}{action && <div className="mt-4">{action}</div>}
  </div>
);

export const Spinner = () => <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>;

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "rose" | "amber" }) {
  return (
    <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={cx("mt-1 text-2xl font-semibold", tone === "rose" && "text-rose-600", tone === "amber" && "text-amber-600")}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

// ───── toasts ─────
type Toast = { id: number; text: string; tone: "ok" | "err" };
const ToastCtx = createContext<(text: string, tone?: "ok" | "err") => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: "ok" | "err" = "ok") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === "err" ? 8000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 left-1/2 z-[60] flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col gap-2">
        {items.map((t) => <div key={t.id} className={cx("rounded-lg px-4 py-3 text-sm text-white shadow-lg", t.tone === "ok" ? "bg-slate-900" : "bg-rose-600")}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
