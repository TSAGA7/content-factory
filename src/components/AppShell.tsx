import { useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, CalendarDays, Factory, FileText, Image, Layers, LayoutDashboard, Lightbulb, ListChecks, LogOut, Menu, OctagonX, ScrollText, Settings, Users } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useNotifications, useStats } from "@/lib/queries";
import { cx } from "./ui";

const NAV = [
  { to: "/", icon: LayoutDashboard, label: "Обзор", end: true },
  { to: "/calendar", icon: CalendarDays, label: "Календарь" },
  { to: "/posts", icon: FileText, label: "Материалы" },
  { to: "/ideas", icon: Lightbulb, label: "Идеи и план" },
  { to: "/media", icon: Image, label: "Медиатека" },
  { to: "/accounts", icon: Users, label: "Аккаунты" },
  { to: "/brands", icon: Layers, label: "Бренды" },
  { to: "/queue", icon: ListChecks, label: "Очередь" },
  { to: "/journal", icon: ScrollText, label: "Журнал" },
  { to: "/settings", icon: Settings, label: "Настройки" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();
  const stats = useStats().data;
  const unread = (useNotifications().data ?? []).filter((n) => !n.read_at).length;

  const side = (
    <nav className="flex h-full flex-col gap-1 p-3">
      <div className="mb-4 flex items-center gap-2 px-2 pt-1 text-lg font-bold"><Factory className="h-6 w-6 text-indigo-600" />Content Factory</div>
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setOpen(false)}
          className={({ isActive }) => cx("flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium",
            isActive ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")}>
          <n.icon className="h-4 w-4" />{n.label}
        </NavLink>
      ))}
      <button onClick={async () => { await supabase.auth.signOut(); qc.clear(); nav("/"); }}
        className="mt-auto flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><LogOut className="h-4 w-4" />Выйти</button>
    </nav>
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 lg:block">{side}</aside>
      {open && <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setOpen(false)}><aside className="h-full w-64 bg-white dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>{side}</aside></div>}
      <div className="lg:pl-60">
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-slate-200 bg-white/90 px-4 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
          <button className="rounded p-2 lg:hidden" onClick={() => setOpen(true)} aria-label="Меню"><Menu className="h-5 w-5" /></button>
          {stats?.emergency_stop && <NavLink to="/settings" className="flex items-center gap-1.5 rounded-full bg-rose-600 px-3 py-1 text-xs font-semibold text-white"><OctagonX className="h-4 w-4" />Публикации остановлены</NavLink>}
          <div className="ml-auto" />
          <NavLink to="/journal?tab=notifications" className="relative rounded-lg p-2 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Уведомления">
            <Bell className="h-5 w-5" />{unread > 0 && <span className="absolute right-1 top-1 rounded-full bg-rose-600 px-1.5 text-[10px] font-bold text-white">{unread}</span>}
          </NavLink>
        </header>
        <main className="mx-auto max-w-7xl p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

export const PageHeader = ({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) => (
  <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
    <div><h1 className="text-2xl font-bold">{title}</h1>{sub && <p className="mt-0.5 text-sm text-slate-500">{sub}</p>}</div>
    {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
  </div>
);
