"use client";

/**
 * «Администрирование» — admin-only panel.
 *
 * Three blocks:
 *  1. Overall statistics (user count, project count, activity).
 *  2. User management (list, create, ban/unban, delete, reset password).
 *  3. Per-user history clearing.
 *
 * All actions go through /api/admin/* endpoints which require the admin role.
 */

import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import {
  Activity,
  Ban,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  PlusCircle,
  ShieldCheck,
  ShieldOff,
  Star,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { PublicUser } from "@/lib/factcheck/types";
import { materialLabel } from "@/lib/factcheck/client";

interface AdminUser {
  id: string;
  username: string;
  role: "admin" | "user";
  banned: boolean;
  bannedReason?: string | null;
  createdAt: string;
  projectCount: number;
  lastActivity: string | null;
}

interface AdminStats {
  users: { total: number; admins: number; regular: number; banned: number };
  projects: {
    total: number;
    running: number;
    completed: number;
    failed: number;
    thisWeek: number;
  };
  topUsers: Array<{
    id: string;
    username: string;
    role: "admin" | "user";
    banned: boolean;
    projectCount: number;
    lastActivity: string | null;
  }>;
}

/** Строка блока «Проекты для показа» (GET /api/admin/projects). */
interface AdminProject {
  id: string;
  url: string;
  mode: string;
  status: string;
  showcase: boolean;
  createdAt: string;
  username: string | null;
  claimCount: number;
  overallVerdict: string | null;
  overallConfidence: number | null;
}

type Toast = { kind: "ok" | "err"; msg: string } | null;

export function AdminView() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [projects, setProjects] = useState<AdminProject[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<Toast>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showcaseBusyId, setShowcaseBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [statsR, usersR, projectsR] = await Promise.all([
        fetch("/api/admin/stats"),
        fetch("/api/admin/users"),
        fetch("/api/admin/projects"),
      ]);
      if (statsR.ok) setStats((await statsR.json()) as AdminStats);
      if (usersR.ok) {
        const data = (await usersR.json()) as { users: AdminUser[] };
        setUsers(data.users);
      }
      if (projectsR.ok) {
        const data = (await projectsR.json()) as { projects: AdminProject[] };
        setProjects(data.projects);
      }
    } catch {
      setToast({ kind: "err", msg: "Не удалось загрузить данные." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const flash = (kind: "ok" | "err", msg: string) => {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 4000);
  };

  const handleBan = async (u: AdminUser) => {
    if (!confirm(
      u.banned
        ? `Разблокировать пользователя «${u.username}»?`
        : `Заблокировать пользователя «${u.username}»? Он не сможет входить в систему.`
    )) return;
    try {
      const r = await fetch(`/api/admin/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ banned: !u.banned }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        flash("err", data.error || "Ошибка запроса. Повторите попытку.");
        return;
      }
      flash("ok", u.banned ? "Пользователь разблокирован." : "Пользователь заблокирован.");
      void reload();
    } catch {
      flash("err", "Сетевая ошибка.");
    }
  };

  const handleDelete = async (u: AdminUser) => {
    if (!confirm(
      `Удалить пользователя «${u.username}»? Все его проверки будут удалены безвозвратно.`
    )) return;
    try {
      const r = await fetch(`/api/admin/users/${u.id}`, { method: "DELETE" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        flash("err", data.error || "Ошибка запроса. Повторите попытку.");
        return;
      }
      flash("ok", "Пользователь удалён.");
      void reload();
    } catch {
      flash("err", "Сетевая ошибка.");
    }
  };

  const handleClearHistory = async (u: AdminUser) => {
    if (!confirm(
      `Очистить всю историю проверок пользователя «${u.username}»? Это действие необратимо.`
    )) return;
    try {
      const r = await fetch(`/api/admin/users/${u.id}/history`, {
        method: "DELETE",
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        flash("err", data.error || "Ошибка запроса. Повторите попытку.");
        return;
      }
      flash("ok", `Удалено проверок: ${data.deleted ?? 0}.`);
      void reload();
    } catch {
      flash("err", "Сетевая ошибка.");
    }
  };

  const handleToggleRole = async (u: AdminUser) => {
    const newRole = u.role === "admin" ? "user" : "admin";
    if (!confirm(
      newRole === "admin"
        ? `Повысить пользователя «${u.username}» до администратора? Он получит полный доступ к управлению пользователями и всем проверкам.`
        : `Понизить администратора «${u.username}» до обычного пользователя? Он потеряет доступ к панели администрирования.`
    )) return;
    try {
      const r = await fetch(`/api/admin/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        flash("err", data.error || "Ошибка запроса. Повторите попытку.");
        return;
      }
      flash("ok", newRole === "admin" ? "Пользователь повышен до администратора." : "Администратор понижен до пользователя.");
      void reload();
    } catch {
      flash("err", "Сетевая ошибка.");
    }
  };

  const handleResetPassword = async (u: AdminUser) => {
    const newPassword = prompt(
      `Сменить пароль пользователя «${u.username}». Введите новый пароль (минимум 6 символов):`
    );
    if (newPassword === null) return;
    if (newPassword.length < 6) {
      flash("err", "Пароль должен быть не короче 6 символов.");
      return;
    }
    try {
      const r = await fetch(`/api/admin/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        flash("err", data.error || "Ошибка запроса. Повторите попытку.");
        return;
      }
      flash("ok", `Пароль пользователя «${u.username}» изменён.`);
      void reload();
    } catch {
      flash("err", "Сетевая ошибка.");
    }
  };

  const handleToggleShowcase = async (p: AdminProject) => {
    if (showcaseBusyId) return;
    setShowcaseBusyId(p.id);
    try {
      const r = await fetch(`/api/admin/projects/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ showcase: !p.showcase }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        flash("err", data.error || "Ошибка запроса. Повторите попытку.");
        return;
      }
      // Оптимистично обновляем локально, без полной перезагрузки.
      setProjects((prev) =>
        prev
          ? prev.map((x) => (x.id === p.id ? { ...x, showcase: !p.showcase } : x))
          : prev,
      );
      flash(
        "ok",
        p.showcase
          ? "Пометка «для показа» снята."
          : "Проект помечен «для показа» и поднимется вверху списков.",
      );
    } catch {
      flash("err", "Сетевая ошибка.");
    } finally {
      setShowcaseBusyId(null);
    }
  };

  if (loading && !stats && !users) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-6 animate-spin text-[#566272]" aria-hidden />
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-2">
      <div className="flex items-center justify-between">
        <h1 className="gx-label text-sm">Администрирование</h1>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="flex h-9 items-center gap-2 rounded-md bg-[#2563EB] px-4 text-xs font-medium text-white transition-colors hover:bg-[#1d4ed8]"
        >
          <UserPlus className="size-3.5" aria-hidden />
          {showCreate ? "Отмена" : "Новый пользователь"}
        </button>
      </div>

      {toast && (
        <div
          className={cn(
            "rounded-md border px-4 py-2.5 text-xs",
            toast.kind === "ok"
              ? "border-[#10b981]/30 bg-[#10b981]/10 text-[#047857]"
              : "border-[#ef4444]/30 bg-[#ef4444]/10 text-[#dc2626]"
          )}
        >
          {toast.msg}
        </div>
      )}

      {showCreate && <CreateUserForm onDone={() => { setShowCreate(false); void reload(); }} onError={flash} />}

      {/* Statistics */}
      {stats && (
        <section className="gx-card p-5 sm:p-6">
          <h2 className="gx-label-card mb-4">Статистика</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              icon={<Users className="size-4" />}
              label="Пользователей"
              value={stats.users.total}
              sub={`${stats.users.admins} адм. · ${stats.users.banned} заблок.`}
            />
            <StatCard
              icon={<Activity className="size-4" />}
              label="Проверок всего"
              value={stats.projects.total}
              sub={`${stats.projects.completed} зав. · ${stats.projects.failed} ошибок`}
            />
            <StatCard
              icon={<CheckCircle2 className="size-4" />}
              label="За неделю"
              value={stats.projects.thisWeek}
              sub={stats.projects.running > 0 ? `${stats.projects.running} выполняется` : "нет активных"}
            />
            <StatCard
              icon={<ShieldCheck className="size-4" />}
              label="Активных"
              value={stats.topUsers.length}
              sub="топ по проверкам"
            />
          </div>
        </section>
      )}

      {/* Projects for showcase */}
      <section className="gx-card overflow-hidden">
        <div className="border-b border-[#e3e5e9] px-4 py-3">
          <h2 className="gx-label-card flex items-center gap-2">
            <Star className="size-3.5 text-[#6b7280]" aria-hidden />
            Проекты для показа
          </h2>
          <p className="mt-1 text-[11px] leading-snug text-[#6b7280]">
            Помеченные проекты поднимаются вверху списков истории.
          </p>
        </div>
        {projects === null ? (
          <p className="px-4 py-6 text-center text-xs text-[#6b7280]">Загрузка…</p>
        ) : projects.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-[#6b7280]">
            Проверок пока нет — запустите первую с главного экрана.
          </p>
        ) : (
          <ul className="gx-scroll-light max-h-80 divide-y divide-[#e3e5e9] overflow-y-auto">
            {projects.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-[#121418]" title={p.url}>
                      {materialLabel(p.url)}
                    </span>
                    {p.status === "failed" && (
                      <span className="shrink-0 rounded border border-[#ef4444]/40 bg-[#ef4444]/10 px-1.5 py-0 text-[10px] font-semibold text-[#dc2626]">
                        Сбой
                      </span>
                    )}
                    {p.showcase && (
                      <span className="shrink-0 rounded border border-[#2563EB]/40 bg-[#2563EB]/10 px-1.5 py-0 text-[10px] font-semibold text-[#2563EB]">
                        Для показа
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-[#6b7280]">
                    <span>{relativeTime(p.createdAt)}</span>
                    <span>·</span>
                    <span>{p.claimCount} утв.</span>
                    {p.username && (
                      <>
                        <span>·</span>
                        <span className="truncate">{p.username}</span>
                      </>
                    )}
                    <span>·</span>
                    <span>{p.mode === "RESEARCH" ? "иссл." : "контр."}</span>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={showcaseBusyId === p.id}
                  onClick={() => void handleToggleShowcase(p)}
                  title={p.showcase ? "Снять пометку «для показа»" : "Пометить «для показа»"}
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-wait disabled:opacity-50",
                    p.showcase
                      ? "bg-[#2563EB]/10 text-[#2563EB] hover:bg-[#2563EB]/20"
                      : "text-[#9ca3af] hover:bg-[#2563EB]/10 hover:text-[#2563EB]",
                  )}
                >
                  {showcaseBusyId === p.id ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Star className={cn("size-3.5", p.showcase && "fill-current")} aria-hidden />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* User table */}
      <section className="gx-card overflow-hidden">
        <div className="border-b border-[#e3e5e9] px-4 py-3">
          <h2 className="gx-label-card">Пользователи</h2>
        </div>
        {users === null ? (
          <p className="px-4 py-8 text-center text-xs text-[#6b7280]">Загрузка…</p>
        ) : users.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-[#6b7280]">Пользователей нет.</p>
        ) : (
          <ul className="gx-scroll-light max-h-[40rem] divide-y divide-[#e3e5e9] overflow-y-auto">
            {users.map((u) => (
              <UserRow
                key={u.id}
                user={u}
                onBan={() => void handleBan(u)}
                onDelete={() => void handleDelete(u)}
                onClearHistory={() => void handleClearHistory(u)}
                onToggleRole={() => void handleToggleRole(u)}
                onResetPassword={() => void handleResetPassword(u)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  sub: string;
}) {
  return (
    <div className="rounded-md border border-[#e3e5e9] bg-white p-3">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-[#6b7280]">
        <span className="text-[#9ca3af]" aria-hidden>{icon}</span>
        {label}
      </div>
      <p className="gx-mono text-xl font-semibold text-[#121418]">{value}</p>
      <p className="mt-0.5 text-[10px] text-[#9ca3af]">{sub}</p>
    </div>
  );
}

function UserRow({
  user,
  onBan,
  onDelete,
  onClearHistory,
  onToggleRole,
  onResetPassword,
}: {
  user: AdminUser;
  onBan: () => void;
  onDelete: () => void;
  onClearHistory: () => void;
  onToggleRole: () => void;
  onResetPassword: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      {/* Username + badges */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-[#121418]">
            {user.username}
          </span>
          {user.role === "admin" && (
            <span className="rounded border border-[#2563EB]/40 bg-[#2563EB]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#2563EB]">
              Админ
            </span>
          )}
          {user.banned && (
            <span className="rounded border border-[#ef4444]/40 bg-[#ef4444]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#dc2626]">
              Заблокирован
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[#6b7280]">
          <span>{user.projectCount} проверок</span>
          {user.lastActivity && (
            <span>· активность {relativeTime(user.lastActivity)}</span>
          )}
          <span>· создан {relativeTime(user.createdAt)}</span>
        </div>
        {user.banned && user.bannedReason && (
          <p className="mt-1 text-[11px] text-[#dc2626]">
            Причина: {user.bannedReason}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onToggleRole}
          title={user.role === "admin" ? "Понизить до пользователя" : "Повысить до администратора"}
          className={cn(
            "flex size-8 items-center justify-center rounded-md transition-colors",
            user.role === "admin"
              ? "text-[#6b7280] hover:bg-[#f59e0b]/10 hover:text-[#f59e0b]"
              : "text-[#2563EB] hover:bg-[#2563EB]/10"
          )}
        >
          {user.role === "admin" ? (
            <ShieldOff className="size-3.5" aria-hidden />
          ) : (
            <ShieldCheck className="size-3.5" aria-hidden />
          )}
        </button>
        <button
          type="button"
          onClick={onResetPassword}
          title="Сменить пароль"
          className="flex size-8 items-center justify-center rounded-md text-[#6b7280] transition-colors hover:bg-[#2563EB]/10 hover:text-[#2563EB]"
        >
          <KeyRound className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onBan}
          title={user.banned ? "Разблокировать" : "Заблокировать"}
          className={cn(
            "flex size-8 items-center justify-center rounded-md transition-colors",
            user.banned
              ? "text-[#10b981] hover:bg-[#10b981]/10"
              : "text-[#f59e0b] hover:bg-[#f59e0b]/10"
          )}
        >
          <Ban className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onClearHistory}
          title="Очистить историю проверок"
          className="flex size-8 items-center justify-center rounded-md text-[#6b7280] transition-colors hover:bg-[#f59e0b]/10 hover:text-[#f59e0b]"
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Удалить пользователя"
          className="flex size-8 items-center justify-center rounded-md text-[#9ca3af] transition-colors hover:bg-[#ef4444]/10 hover:text-[#dc2626]"
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      </div>
    </li>
  );
}

function CreateUserForm({
  onDone,
  onError,
}: {
  onDone: () => void;
  onError: (kind: "ok" | "err", msg: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const r = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password, role }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        onError("err", data.error || "Ошибка запроса. Повторите попытку.");
        setSubmitting(false);
        return;
      }
      onError("ok", `Пользователь «${username.trim()}» создан.`);
      onDone();
    } catch {
      onError("err", "Сетевая ошибка.");
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="gx-card space-y-3 p-5"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-[#121418]">
        <PlusCircle className="size-4 text-[#2563EB]" aria-hidden />
        Создание пользователя
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-[11px] text-[#6b7280]">Имя пользователя</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            minLength={3}
            placeholder="username"
            className="h-10 w-full rounded-md border border-[#e3e5e9] bg-white px-3 text-sm outline-none focus:border-[#2563EB]/60"
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-[#6b7280]">Пароль</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={6}
            placeholder="••••••"
            autoComplete="new-password"
            className="h-10 w-full rounded-md border border-[#e3e5e9] bg-white px-3 text-sm outline-none focus:border-[#2563EB]/60"
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-[#6b7280]">Роль</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "admin" | "user")}
            className="h-10 w-full rounded-md border border-[#e3e5e9] bg-white px-3 text-sm outline-none focus:border-[#2563EB]/60"
          >
            <option value="user">Пользователь</option>
            <option value="admin">Администратор</option>
          </select>
        </div>
      </div>
      <button
        type="submit"
        disabled={submitting || !username.trim() || !password}
        className="flex h-10 items-center gap-2 rounded-md bg-[#2563EB] px-4 text-xs font-medium text-white transition-colors hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        {submitting ? "Создание…" : "Создать"}
      </button>
    </form>
  );
}

function relativeTime(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ru });
  } catch {
    return "—";
  }
}

