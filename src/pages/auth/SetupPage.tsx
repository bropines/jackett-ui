import { Loader2, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";

import { ApiError, errText, serverApi } from "@/api";
import { Callout, Field } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MIN_PASSWORD, newPasswordError, usernameError } from "@/lib/auth";
import { AuthLayout } from "@/pages/auth/AuthLayout";
import { SecretInput } from "@/pages/settings/parts";

/** First start: no users yet. Creates the first admin; Jackett is not reachable until this is done. */
export function SetupPage({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("admin");
  const [pw, setPw] = useState("");
  const [repeat, setRepeat] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const userInvalid = usernameError(username);
  const invalid = newPasswordError(pw, repeat);
  const shownError = touched ? invalid : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (invalid || userInvalid) return;
    setBusy(true);
    setError("");
    try {
      await serverApi.setup({ username: username.trim().toLowerCase(), password: pw });
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
    <AuthLayout title="Первый запуск" description="Создайте администратора. Jackett будет доступен только после входа.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Имя пользователя" htmlFor="setup-user" error={touched ? userInvalid : undefined} hint="Латиница, цифры, точка, дефис">
          <Input
            id="setup-user"
            name="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={touched && !!userInvalid ? true : undefined}
          />
        </Field>
        <Field label="Пароль" htmlFor="setup-pw" hint={`Не короче ${MIN_PASSWORD} символов`}>
          <SecretInput id="setup-pw" value={pw} onChange={setPw} autoComplete="new-password" />
        </Field>
        <Field label="Ещё раз" htmlFor="setup-pw2" error={shownError}>
          <SecretInput id="setup-pw2" value={repeat} onChange={setRepeat} autoComplete="new-password" invalid={!!shownError} />
        </Field>
        {error && <Callout variant="error">{error}</Callout>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          Создать и войти
        </Button>
        <p className="text-xs text-muted-foreground">
          Других пользователей можно пригласить позже в настройках. Забыли пароль — перезапустите контейнер с{" "}
          <span className="font-mono">AUTH_RESET=1</span>.
        </p>
      </form>
    </AuthLayout>
  );
}
