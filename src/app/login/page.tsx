"use client";

/**
 * /login — username/password authentication page.
 *
 * The middleware redirects here when no valid session cookie is present.
 * On submit we POST /api/login which verifies credentials against the User
 * table and sets an httpOnly session cookie.
 *
 * The `?banned=1` query param shows a "your access is restricted" message
 * (displayed when a banned user's token is detected by the middleware).
 */

import { useState, FormEvent, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Lock, ShieldCheck, UserCircle } from "lucide-react";
import type { PublicUser } from "@/lib/factcheck/types";

/**
 * WHY Suspense: this page reads the query string via useSearchParams()
 * (?next=…, ?banned=1). During the production build Next.js prerenders
 * pages, and a client component touching useSearchParams() forces a
 * client-side render bailout. Without a <Suspense> boundary above it,
 * `next build` fails with:
 *   "useSearchParams() should be wrapped in a suspense boundary at
 *    page \"/login\"" (missing-suspense-with-csr-bailout).
 * The wrapper defers the query-string read to the client render and shows
 * a static skeleton while the form hydrates.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginForm />
    </Suspense>
  );
}

/** Static placeholder shown while the /login route is being hydrated. */
function LoginFallback() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#0f1114] px-4 py-8">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span
            aria-hidden
            className="flex size-9 items-center justify-center rounded-[6px] border border-[#2563EB]/50 bg-[#2563EB]/10 text-[#60a5fa]"
          >
            <svg
              viewBox="0 0 24 24"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <path
                d="M12 3l7 3v5c0 4.6-2.9 8.1-7 10-4.1-1.9-7-5.4-7-10V6l7-3z"
                strokeLinejoin="round"
              />
              <path
                d="M9 12l2 2 4-4.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="gx-display text-base tracking-[0.18em] text-[#f4f5f7]">
            ФАКТУМ
          </span>
        </div>
        <div
          aria-hidden
          className="rounded-lg border border-white/10 bg-[#171a1f] p-6 shadow-[0_24px_64px_rgba(0,0,0,0.55)]"
        >
          <div className="mb-4 h-4 w-28 rounded bg-white/[0.06]" />
          <div className="mb-5 h-3 w-64 rounded bg-white/[0.04]" />
          <div className="mb-4 h-11 w-full rounded-md bg-white/[0.04]" />
          <div className="h-11 w-full rounded-md bg-white/[0.04]" />
        </div>
      </div>
    </div>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const banned = params.get("banned") === "1";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // If the user was redirected here with ?banned=1, pre-fill the error so
  // they see why — no effect needed, the initial state carries it.
  const [error, setError] = useState<string | null>(
    banned ? "Ваш доступ к сервису ограничен администратором." : null
  );

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`/api/login?next=${encodeURIComponent(next)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        next?: string;
        error?: string;
        user?: PublicUser;
        banned?: boolean;
      };
      if (!r.ok || !data.ok) {
        setError(data.error || `Не удалось войти (HTTP ${r.status}).`);
        setSubmitting(false);
        return;
      }
      // Navigate to the next path — the httpOnly cookie is already set.
      router.replace(data.next || next || "/");
      router.refresh();
    } catch {
      setError("Сетевая ошибка. Проверьте соединение и повторите.");
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#0f1114] px-4 py-8">
      <div className="w-full max-w-md">
        {/* Brand */}
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span
            aria-hidden
            className="flex size-9 items-center justify-center rounded-[6px] border border-[#2563EB]/50 bg-[#2563EB]/10 text-[#60a5fa]"
          >
            <svg
              viewBox="0 0 24 24"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <path
                d="M12 3l7 3v5c0 4.6-2.9 8.1-7 10-4.1-1.9-7-5.4-7-10V6l7-3z"
                strokeLinejoin="round"
              />
              <path
                d="M9 12l2 2 4-4.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="gx-display text-base tracking-[0.18em] text-[#f4f5f7]">
            ФАКТУМ
          </span>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-lg border border-white/10 bg-[#171a1f] p-6 shadow-[0_24px_64px_rgba(0,0,0,0.55)]"
        >
          <div className="mb-4 flex items-center gap-2.5">
            <Lock className="size-4 text-[#60a5fa]" aria-hidden />
            <h1 className="text-sm font-medium text-[#f4f5f7]">
              Вход в систему
            </h1>
          </div>
          <p className="mb-5 text-xs leading-relaxed text-[#9ca3af]">
            Введите имя пользователя и пароль для доступа к системе фактчекинга.
          </p>

          {/* Username */}
          <label className="mb-1.5 block text-xs font-medium text-[#c3c8cf]">
            Имя пользователя
          </label>
          <div className="relative mb-4">
            <UserCircle
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#566272]"
              aria-hidden
            />
            <input
              type="text"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              className="h-11 w-full rounded-md border border-white/10 bg-white/[0.04] pl-10 pr-3 text-sm text-[#f4f5f7] outline-none transition-colors placeholder:text-[#566272] focus:border-[#2563EB]/60"
              required
            />
          </div>

          {/* Password */}
          <label className="mb-1.5 block text-xs font-medium text-[#c3c8cf]">
            Пароль
          </label>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="h-11 w-full rounded-md border border-white/10 bg-white/[0.04] px-3 text-sm text-[#f4f5f7] outline-none transition-colors placeholder:text-[#566272] focus:border-[#2563EB]/60"
            required
          />

          {error && (
            <p className="mt-3 rounded-md border border-[#ef4444]/30 bg-[#ef4444]/10 px-3 py-2 text-xs text-[#f87171]">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !username.trim() || !password}
            className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[#2563EB] px-4 text-sm font-medium text-white transition-colors hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Вход…
              </>
            ) : (
              <>
                <ShieldCheck className="size-4" aria-hidden />
                Войти
              </>
            )}
          </button>
        </form>

        <p className="mt-6 text-center text-[11px] text-[#566272]">
          Система верификации информации, а не диагностический инструмент.
        </p>
      </div>
    </div>
  );
}
