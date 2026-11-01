export const fmtDateTime = (iso: string | null | undefined, tz?: string) =>
  iso ? new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date(iso)) : "—";

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(iso)) : "—";

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "никогда";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s} с назад`;
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `${Math.round(s / 3600)} ч назад`;
  return `${Math.round(s / 86400)} дн назад`;
}

export const fmtBytes = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} КБ` : `${(n / 1024 / 1024).toFixed(1)} МБ`);
export const fmtUsd = (n: number | null | undefined) => (n == null ? "Нет данных" : `$${Number(n).toFixed(2)}`);

/** datetime-local value (wall clock in tz) ↔ ISO */
export function toLocalInput(iso: string | null, tz: string): string {
  if (!iso) return "";
  const p = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  return p.replace(" ", "T");
}

export const TIMEZONES = ["Europe/Moscow", "Europe/Kaliningrad", "Europe/Samara", "Asia/Yekaterinburg", "Asia/Novosibirsk", "Asia/Vladivostok",
  "Europe/Madrid", "Europe/London", "Europe/Berlin", "Asia/Dubai", "Asia/Bangkok", "America/New_York", "America/Los_Angeles", "UTC"];
