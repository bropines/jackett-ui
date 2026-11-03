import { Github, KeyRound, Loader2, LogIn } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { ApiError, errText, providerStartUrl, serverApi, type AuthState, type ProviderId } from "@/api";
import { rateLimitText } from "@/api/http";
import { Callout, Field } from "@/components/common";
import { Button } from "@/components/ui/button";
import { authErrorText } from "@/lib/auth";
import { AuthLayout } from "@/pages/auth/AuthLayout";
import { SecretInput } from "@/pages/settings/parts";

/** Reads `?authError=` (set by the OIDC callback) and removes it from the address bar. */
function useAuthErrorParam(): string | null {
  const [code] = useState(() => new URLSearchParams(window.location.search).get("authError"));
  useEffect(() => {
    if (!code) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("authError");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [code]);
  return code;
}

/** Where to come back after the IdP: the current page without `authError`. */
export function currentReturnPath(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("authError");
  return `${url.pathname}${url.search}`;
}

/** Brand-neutral icons: lucide's GitHub mark, a generic one for the rest. */
function ProviderIcon({ id }: { id: ProviderId }) {
  return id === "github" ? <Github /> : <LogIn />;
}

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
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
  const wait = useCountdown(blockedUntil);
  const blocked = wait > 0;

  const providers = state.providers ?? [];
  const external = providers.length > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password || blocked) return;
    setBusy(true);
    setError("");
    try {
      await serverApi.login(password);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const secs = err.retryAfter ?? 60;
        setBlockedUntil(Date.now() + secs * 1000);
        setError("");
      } else if (err instanceof ApiError && err.status === 401) {
        setError("Неверный пароль");
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
            <Button key={p.id} asChild className="w-full" variant={state.passwordLogin || providers.length > 1 ? "outline" : "default"}>
              <a href={providerStartUrl(p.id, currentReturnPath())}>
                <ProviderIcon id={p.id} /> Войти через {p.name}
              </a>
            </Button>
          ))}
        </div>
      )}

      {external && state.passwordLogin && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-hidden>
          <span className="h-px flex-1 bg-border" /> или <span className="h-px flex-1 bg-border" />
        </div>
      )}

      {state.passwordLogin && (
        <form onSubmit={submit} className="space-y-3">
          <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
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

      {!external && !state.passwordLogin && (
        <Callout variant="warning" title="Вход недоступен">
          {state.mode === "header"
            ? "Интерфейс ожидает, что вход выполнит прокси-сервер авторизации перед ним, но запрос пришёл без нужного заголовка. Откройте адрес через этот прокси."
            : "Ни пароль, ни внешний вход не настроены. Задайте AUTH_PASSWORD или настройки провайдера (OIDC, Google, GitHub) в переменных окружения сервера."}
        </Callout>
      )}
    </AuthLayout>
  );
}
