import { Loader2, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";

import { ApiError, errText, serverApi } from "@/api";
import { Callout } from "@/components/common";
import { Button } from "@/components/ui/button";
import { AccountFields } from "@/pages/auth/AccountFields";
import { AuthLayout } from "@/pages/auth/AuthLayout";
import { serverErrorField, setupBody, validateAccount, type AccountErrors, type AccountForm } from "@/pages/auth/onboarding";

/**
 * First start: no users yet. Creates the first admin; Jackett is not reachable until this is done.
 * `onDone(created)`: true after a successful setup (the gate then opens the login methods page).
 */
export function SetupPage({ onDone }: { onDone: (created: boolean) => void }) {
  const [form, setForm] = useState<AccountForm>({ username: "admin", name: "", email: "", password: "", repeat: "" });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [serverErrors, setServerErrors] = useState<AccountErrors>({});

  const errors = validateAccount(form);
  const invalid = Object.keys(errors).length > 0;
  const shown: AccountErrors = { ...(touched ? errors : {}), ...serverErrors };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    setError("");
    setServerErrors({});
    try {
      await serverApi.setup(setupBody(form));
      onDone(true);
    } catch (err) {
      // 409: someone else finished the setup meanwhile → the gate re-reads the state.
      if (err instanceof ApiError && err.status === 409 && err.code !== "email_taken" && err.code !== "username_taken") return onDone(false);
      const field = err instanceof ApiError ? serverErrorField(err.code, err.field) : undefined;
      if (field) setServerErrors({ [field]: errText(err) });
      else setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Первый запуск" description="Создайте администратора. Jackett будет доступен только после входа." wide>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <AccountFields
          idPrefix="setup"
          form={form}
          errors={shown}
          onChange={(p) => {
            setForm((f) => ({ ...f, ...p }));
            if (p.username !== undefined || p.email !== undefined) setServerErrors({});
          }}
        />
        {error && <Callout variant="error">{error}</Callout>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          Создать и войти
        </Button>
        <p className="text-xs text-muted-foreground">
          Других пользователей можно пригласить позже в настройках. Забыли пароль — выполните в контейнере{" "}
          <span className="font-mono">jackett-ui reset-password &lt;пользователь&gt;</span>.
        </p>
      </form>
    </AuthLayout>
  );
}
