import { Loader2, UserCheck, UserPlus, UserRoundCog } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import { ApiError, errText, serverApi, type AuthState } from "@/api";
import { Callout, ConfirmDialog } from "@/components/common";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { AccountFields } from "@/pages/auth/AccountFields";
import { AuthLayout } from "@/pages/auth/AuthLayout";
import {
  onboardingBody,
  serverErrorField,
  validateAccount,
  type AccountErrors,
  type AccountForm,
  type OnboardingMode,
} from "@/pages/auth/onboarding";

const MODES: { id: OnboardingMode; title: string; description: string; icon: ReactNode }[] = [
  {
    id: "replace",
    title: "Заменить admin",
    description: "Учётная запись admin станет вашей: новое имя и пароль. Вход admin с паролем из AUTH_PASSWORD перестанет работать.",
    icon: <UserRoundCog className="h-5 w-5" aria-hidden />,
  },
  {
    id: "add",
    title: "Добавить ещё одного администратора",
    description: "Создаётся новый администратор, вы войдёте под ним. admin с паролем из AUTH_PASSWORD останется.",
    icon: <UserPlus className="h-5 w-5" aria-hidden />,
  },
];

/**
 * First-login wizard, account step: shown by the gate while `auth/state.onboarding` is true
 * (logged in as the initial admin from AUTH_PASSWORD). `onDone(created)`: true after replace / add.
 */
export function OnboardingPage({ state, onDone }: { state: AuthState; onDone: (created: boolean) => void }) {
  const [mode, setMode] = useState<OnboardingMode | null>(null);
  const [form, setForm] = useState<AccountForm>({ username: "", name: "", email: state.user?.email ?? "", password: "", repeat: "" });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [serverErrors, setServerErrors] = useState<AccountErrors>({});
  const [confirmSkip, setConfirmSkip] = useState(false);

  const errors = validateAccount(form);
  const invalid = Object.keys(errors).length > 0;
  const shown: AccountErrors = { ...(touched ? errors : {}), ...serverErrors };

  const fail = (err: unknown) => {
    // Someone (another tab) finished it already: the gate re-reads the state.
    if (err instanceof ApiError && err.code === "not_onboarding") return onDone(false);
    const field = err instanceof ApiError ? serverErrorField(err.code, err.field) : undefined;
    if (field) setServerErrors({ [field]: errText(err) });
    else setError(errText(err));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!mode) return;
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    setError("");
    setServerErrors({});
    try {
      await serverApi.onboarding(onboardingBody(mode, form));
      onDone(true);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function skip() {
    setBusy(true);
    setError("");
    try {
      await serverApi.onboarding({ mode: "skip" });
      setConfirmSkip(false);
      onDone(false);
    } catch (err) {
      setConfirmSkip(false);
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Своя учётная запись" description="Вы вошли как admin с паролем из AUTH_PASSWORD. Создайте свою учётную запись." wide>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <RadioGroup value={mode ?? ""} onValueChange={(v) => setMode(v as OnboardingMode)} aria-label="Что сделать с admin" className="gap-3">
          {MODES.map((m) => (
            <Label
              key={m.id}
              htmlFor={`onb-mode-${m.id}`}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors hover:bg-muted/50",
                mode === m.id && "border-primary bg-primary/5",
              )}
            >
              <RadioGroupItem value={m.id} id={`onb-mode-${m.id}`} className="mt-1" />
              <span className="mt-0.5 text-muted-foreground">{m.icon}</span>
              <span className="min-w-0 space-y-1">
                <span className="block font-medium">{m.title}</span>
                <span className="block text-xs text-muted-foreground">{m.description}</span>
              </span>
            </Label>
          ))}
        </RadioGroup>

        {mode && (
          <>
            <AccountFields
              idPrefix="onb"
              form={form}
              errors={shown}
              onChange={(p) => {
                setForm((f) => ({ ...f, ...p }));
                if (p.username !== undefined || p.email !== undefined) setServerErrors({});
              }}
            />
            {error && <Callout variant="error">{error}</Callout>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <UserCheck />}
              {mode === "replace" ? "Сохранить" : "Создать и войти"}
            </Button>
          </>
        )}
        {!mode && error && <Callout variant="error">{error}</Callout>}

        <div className="text-center">
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setConfirmSkip(true)}
            disabled={busy}
          >
            Пропустить
          </button>
        </div>
      </form>

      <ConfirmDialog
        open={confirmSkip}
        onOpenChange={(o) => !busy && setConfirmSkip(o)}
        title="Пропустить?"
        description="Останется вход admin с паролем из AUTH_PASSWORD. Свою учётную запись можно создать позже в настройках, на вкладке «Пользователи»."
        confirmLabel="Пропустить"
        pending={busy}
        onConfirm={() => void skip()}
      />
    </AuthLayout>
  );
}
