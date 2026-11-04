import { KeyRound, Loader2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { ApiError, errText, providerStartUrl, serverApi, type AuthState } from "@/api";
import { rateLimitText } from "@/api/http";
import { ProviderIcon } from "@/components/auth/ProviderIcon";
import { Callout, Field } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authErrorText } from "@/lib/auth";
import { currentReturnPath, useAuthErrorParam } from "@/lib/auth-hooks";
import { AuthLayout } from "@/pages/auth/AuthLayout";
import { SecretInput } from "@/pages/settings/parts";

/** Seconds left until `until` (ms timestamp), ticking every second. */
function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

export function LoginPage({ state, onDone }: { state: AuthState; onDone: () => void }) {
  const authError = useAuthErrorParam();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
  const wait = useCountdown(blockedUntil);
  const blocked = wait > 0;

  const methods = state.methods ?? { password: false, providers: [], header: false };
  const providers = methods.providers ?? [];
  const external = providers.length > 0;
  const passwordLogin = methods.password;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password || blocked) return;
    setBusy(true);
    setError("");
    try {
      await serverApi.login({ username: username.trim() || "admin", password });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const secs = err.retryAfter ?? 60;
        setBlockedUntil(Date.now() + secs * 1000);
        setError("");
      } else if (err instanceof ApiError && err.status === 401) {
        setError("Неверное имя пользователя или пароль");
      } else {
        setError(errText(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Jackett" description="Войдите, чтобы продолжить.">
      {authError && (
        <Callout variant="error" title="Вход не выполнен">
          {authErrorText(authError)}
        </Callout>
      )}

      {external && (
        <div className="space-y-2">
          {providers.map((p) => (
            <Button key={p.id} asChild className="w-full" variant={passwordLogin || providers.length > 1 ? "outline" : "default"}>
              <a href={providerStartUrl(p.id, currentReturnPath())}>
                <ProviderIcon id={p.id} /> Войти через {p.name}
              </a>
            </Button>
          ))}
        </div>
      )}

      {external && passwordLogin && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-hidden>
          <span className="h-px flex-1 bg-border" /> или <span className="h-px flex-1 bg-border" />
        </div>
      )}

      {passwordLogin && (
        <form onSubmit={submit} className="space-y-3">
          <Field label="Имя пользователя" htmlFor="login-user">
            <Input
              id="login-user"
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field label="Пароль" htmlFor="login-pw">
            <SecretInput id="login-pw" value={password} onChange={setPassword} autoComplete="current-password" invalid={!!error} />
          </Field>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {blocked && (
            <p className="text-sm text-destructive" role="alert">
              {rateLimitText(wait)}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={busy || blocked || !password}>
            {busy ? <Loader2 className="animate-spin" /> : <KeyRound />} Войти
          </Button>
        </form>
      )}

      {!external && !passwordLogin && (
        <Callout variant="warning" title="Вход недоступен">
          {methods.header
            ? "Интерфейс ожидает, что вход выполнит прокси-сервер авторизации перед ним, но запрос пришёл без нужного заголовка или такого пользователя нет. Откройте адрес через этот прокси."
            : "Ни один способ входа не включён. Задайте AUTH_METHODS и настройки провайдера (OIDC, Google, GitHub) или AUTH_PASSWORD в переменных окружения сервера."}
        </Callout>
      )}
    </AuthLayout>
  );
}
