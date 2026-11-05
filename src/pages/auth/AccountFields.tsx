import { Field } from "@/components/common";
import { Input } from "@/components/ui/input";
import { EMAIL_MAX, MIN_PASSWORD } from "@/lib/auth";
import type { AccountErrors, AccountForm } from "@/pages/auth/onboarding";
import { SecretInput } from "@/pages/settings/parts";

/** Username, name, e-mail (optional), password + repeat: used by the setup page and the first-login wizard. */
export function AccountFields({
  idPrefix,
  form,
  errors,
  onChange,
}: {
  idPrefix: string;
  form: AccountForm;
  /** Already filtered: only what should be shown now. */
  errors: AccountErrors;
  onChange: (patch: Partial<AccountForm>) => void;
}) {
  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <>
      <Field label="Имя пользователя" htmlFor={id("user")} error={errors.username} hint="Латиница, цифры, точка, дефис">
        <Input
          id={id("user")}
          name="username"
          value={form.username}
          onChange={(e) => onChange({ username: e.target.value })}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={errors.username ? true : undefined}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Имя" htmlFor={id("name")} hint="Как вас показывать">
          <Input id={id("name")} value={form.name} onChange={(e) => onChange({ name: e.target.value })} maxLength={64} autoComplete="name" />
        </Field>
        <Field label="Почта" htmlFor={id("email")} error={errors.email} hint="Необязательно">
          <Input
            id={id("email")}
            type="email"
            value={form.email}
            onChange={(e) => onChange({ email: e.target.value })}
            maxLength={EMAIL_MAX}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={errors.email ? true : undefined}
          />
        </Field>
      </div>
      <Field label="Пароль" htmlFor={id("pw")} hint={`Не короче ${MIN_PASSWORD} символов`}>
        <SecretInput id={id("pw")} value={form.password} onChange={(v) => onChange({ password: v })} autoComplete="new-password" />
      </Field>
      <Field label="Ещё раз" htmlFor={id("pw2")} error={errors.password}>
        <SecretInput id={id("pw2")} value={form.repeat} onChange={(v) => onChange({ repeat: v })} autoComplete="new-password" invalid={!!errors.password} />
      </Field>
    </>
  );
}
