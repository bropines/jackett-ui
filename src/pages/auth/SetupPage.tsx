import { Loader2, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";

import { ApiError, errText, serverApi } from "@/api";
import { Callout, Field } from "@/components/common";
import { Button } from "@/components/ui/button";
import { MIN_PASSWORD, newPasswordError } from "@/lib/auth";
import { AuthLayout } from "@/pages/auth/AuthLayout";
import { SecretInput } from "@/pages/settings/parts";

/** First start: no admin password yet. Jackett is not reachable until this is done. */
export function SetupPage({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [repeat, setRepeat] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const invalid = newPasswordError(pw, repeat);
  const shownError = touched ? invalid : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    setError("");
    try {
      await serverApi.setup(pw);
      onDone();
    } catch (err) {
      // 409: someone else finished the setup meanwhile → the gate re-reads the state.
      if (err instanceof ApiError && err.status === 409) onDone();
      else setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Первый запуск" description="Задайте пароль администратора. Jackett будет доступен только после входа.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
        <Field label="Пароль" htmlFor="setup-pw" hint={`Не короче ${MIN_PASSWORD} символов`}>
          <SecretInput id="setup-pw" value={pw} onChange={setPw} autoComplete="new-password" />
        </Field>
        <Field label="Ещё раз" htmlFor="setup-pw2" error={shownError}>
          <SecretInput id="setup-pw2" value={repeat} onChange={setRepeat} autoComplete="new-password" invalid={!!shownError} />
        </Field>
        {error && <Callout variant="error">{error}</Callout>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          Сохранить и войти
        </Button>
        <p className="text-xs text-muted-foreground">
          Имя пользователя — <span className="font-medium">admin</span>. Позже можно включить вход через SSO в настройках. Забыли
          пароль — перезапустите контейнер с <span className="font-mono">AUTH_RESET=1</span>.
        </p>
      </form>
    </AuthLayout>
  );
}
