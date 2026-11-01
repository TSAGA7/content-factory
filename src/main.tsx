import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import "./index.css";
import { supabase } from "./lib/supabase";
import { AppShell } from "./components/AppShell";
import { Spinner, ToastProvider } from "./components/ui";
import { AuthPage } from "./pages/Auth";
import { Dashboard } from "./pages/Dashboard";
import { BrandsPage } from "./pages/Brands";
import { AccountsPage } from "./pages/Accounts";
import { CalendarPage } from "./pages/Calendar";
import { PostsPage } from "./pages/Posts";
import { EditorPage } from "./pages/Editor";
import { IdeasPage } from "./pages/Ideas";
import { MediaPage } from "./pages/Media";
import { QueuePage } from "./pages/Queue";
import { JournalPage } from "./pages/Journal";
import { SettingsPage } from "./pages/Settings";

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: true } } });

function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  if (session === undefined) return <Spinner />;
  if (!session) return <AuthPage />;
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/posts" element={<PostsPage />} />
        <Route path="/posts/:id" element={<EditorPage />} />
        <Route path="/ideas" element={<IdeasPage />} />
        <Route path="/media" element={<MediaPage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/brands" element={<BrandsPage />} />
        <Route path="/queue" element={<QueuePage />} />
        <Route path="/journal" element={<JournalPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<p>Страница не найдена</p>} />
      </Routes>
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <HashRouter><App /></HashRouter>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
