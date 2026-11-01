import { useState } from "react";
import { Factory } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Button, Input, Label } from "@/components/ui";

export function AuthPage() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ t: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const { error, data } = mode === "in"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin + window.location.pathname } });
    setBusy(false);
    if (error) setMsg({ t: /already has an owner|Регистрация закрыта|Database error saving new user/i.test(error.message) ? "Регистрация закрыта: у приложения уже есть владелец" : error.message, err: true });
    else if (mode === "up" && !data.session) setMsg({ t: "Проверьте почту и подтвердите адрес, затем войдите." });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        <div className="flex items-center gap-2 text-xl font-bold"><Factory className="h-7 w-7 text-indigo-600" />Content Factory</div>
        <p className="text-sm text-slate-500">{mode === "in" ? "Вход в рабочее пространство" : "Первая регистрация создаёт владельца приложения. После неё регистрация закрывается."}</p>
        <Label label="Email"><Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Label>
        <Label label="Пароль" hint={mode === "up" ? "Не короче 8 символов" : undefined}><Input type="password" required minLength={mode === "up" ? 8 : 6} autoComplete={mode === "in" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} /></Label>
        {msg && <p className={msg.err ? "text-sm text-rose-600" : "text-sm text-emerald-600"}>{msg.t}</p>}
        <Button variant="primary" className="w-full" loading={busy}>{mode === "in" ? "Войти" : "Создать аккаунт"}</Button>
        <button type="button" className="w-full text-center text-sm text-indigo-600" onClick={() => { setMode(mode === "in" ? "up" : "in"); setMsg(null); }}>
          {mode === "in" ? "Первый запуск? Зарегистрироваться" : "Уже есть аккаунт? Войти"}
        </button>
      </form>
    </div>
  );
}
