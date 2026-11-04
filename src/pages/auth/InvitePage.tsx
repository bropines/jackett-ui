import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Loader2, MailX, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";

import { ApiError, errText, inviteMethods, providerInviteUrl, qk, serverApi } from "@/api";
import { ProviderIcon } from "@/components/auth/ProviderIcon";
import { RoleBadge } from "@/components/auth/RoleBadge";
import { Callout, Field } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authErrorText, MIN_PASSWORD, newPasswordError, ROLE_HINTS, usernameError } from "@/lib/auth";
import { useAuthErrorParam } from "@/lib/auth-hooks";
import { resetSession } from "@/lib/auth-query";
import { formatDateTime } from "@/lib/format";
import { AuthLayout } from "@/pages/auth/AuthLayout";
import { SecretInput } from "@/pages/settings/parts";

/** Russian text for a dead invite (404 / 410 + code). */
export function inviteErrorText(err: unknown): { title: string; description: string } {
  const code = err instanceof ApiError ? err.code : undefined;
  if (code === "invite_used") return { title: "Приглашение уже использовано", description: "По одной ссылке можно создать только один аккаунт. Если это были вы — просто войдите." };
  if (code === "invite_expired" || (err instanceof ApiError && err.status === 410 && !code))
    return { title: "Срок приглашения истёк", description: "Попросите администратора прислать новую ссылку." };
  if (err instanceof ApiError && (err.status === 404 || err.status === 410 || code === "invite_not_found"))
    return { title: "Приглашение не найдено", description: "Ссылка неверная или приглашение отозвано. Попросите администратора прислать новую." };
  return { title: "Не удалось открыть приглашение", description: errText(err) };
}

/** Public page `/invite/:token`: create an account from a one-time invite. */
export function InvitePage() {
  const { token } = useParams({ from: "/invite/$token" });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const authError = useAuthErrorParam();
  const q = useQuery({ queryKey: qk.publicInvite(token), queryFn: () => serverApi.invite(token), retry: false, refetchOnWindowFocus: false });

  const [username, setUsername] = useState("");
  const [pw, setPw] = useState("");
  const [repeat, setRepeat] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (q.isPending) {
    return (
      <AuthLayout title="Приглашение">
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Проверяю приглашение…
        </p>
      </AuthLayout>
    );
  }
  if (q.isError) {
    const t = inviteErrorText(q.error);
    return (
      <AuthLayout title="Приглашение">
        <div className="flex flex-col items-center gap-2 py-2 text-center" role="alert">
          <div className="rounded-full bg-muted p-3">
            <MailX className="h-5 w-5 text-muted-foreground" aria-hidden />
          </div>
          <p className="font-medium">{t.title}</p>
          <p className="text-sm text-muted-foreground">{t.description}</p>
          <Button variant="outline" className="mt-2" onClick={() => void navigate({ to: "/" })}>
            На страницу входа
          </Button>
        </div>
      </AuthLayout>
    );
  }

  const inv = q.data;
  const methods = inviteMethods(inv.methods);
  const userErr = usernameError(username);
  const pwErr = newPasswordError(pw, repeat);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (userErr || pwErr) return;
    setBusy(true);
    setError("");
    try {
      await serverApi.acceptInvite(token, { username: username.trim().toLowerCase(), password: pw });
      await resetSession(qc);
      void navigate({ to: "/" });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
        setError(inviteErrorText(err).title);
      } else setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Приглашение" description="Вас пригласили в Jackett. Создайте аккаунт, чтобы войти.">
      {authError && (
        <Callout variant="error" title="Не получилось">
          {authErrorText(authError)}
        </Callout>
      )}
      <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{inv.name || "Без имени"}</span>
          <RoleBadge role={inv.role} />
        </div>
        <p className="text-xs text-muted-foreground">{ROLE_HINTS[inv.role]}</p>
        {inv.expiresAt && <p className="text-xs text-muted-foreground">Действует до {formatDateTime(inv.expiresAt)}</p>}
      </div>

      {methods.providers.length > 0 && (
        <div className="space-y-2">
          {methods.providers.map((p) => (
            <Button key={p.id} asChild variant="outline" className="w-full">
              <a href={providerInviteUrl(p.id, token)}>
                <ProviderIcon id={p.id} /> Продолжить через {p.name}
              </a>
            </Button>
          ))}
        </div>
      )}

      {methods.providers.length > 0 && methods.password && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-hidden>
          <span className="h-px flex-1 bg-border" /> или <span className="h-px flex-1 bg-border" />
        </div>
      )}

      {methods.password && (
        <form onSubmit={submit} className="space-y-3" noValidate>
          <Field label="Имя пользователя" htmlFor="inv-user" error={touched ? userErr : undefined} hint="Латиница, цифры, точка, дефис">
            <Input
              id="inv-user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={touched && !!userErr ? true : undefined}
            />
          </Field>
          <Field label="Пароль" htmlFor="inv-pw" hint={`Не короче ${MIN_PASSWORD} символов`}>
            <SecretInput id="inv-pw" value={pw} onChange={setPw} autoComplete="new-password" />
          </Field>
          <Field label="Ещё раз" htmlFor="inv-pw2" error={touched ? pwErr : undefined}>
            <SecretInput id="inv-pw2" value={repeat} onChange={setRepeat} autoComplete="new-password" invalid={touched && !!pwErr} />
          </Field>
          {error && <Callout variant="error">{error}</Callout>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <UserPlus />} Создать аккаунт
          </Button>
        </form>
      )}

      {!methods.password && methods.providers.length === 0 && (
        <Callout variant="warning" title="Нет доступного способа входа">
          Сейчас не включён ни вход по паролю, ни внешние провайдеры. Сообщите администратору.
        </Callout>
      )}
    </AuthLayout>
  );
}
