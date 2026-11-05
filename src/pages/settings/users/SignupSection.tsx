import { useQuery } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";

import { qk, ROLES, serverApi, type Role, type UiSettings } from "@/api";
import { Callout, ErrorState, Field } from "@/components/common";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ROLE_HINTS, ROLE_LABELS } from "@/lib/auth";
import { allowListsEmpty, lockedHint, P, type FieldPath } from "@/pages/settings/auth/logic";
import { Section, SectionFooter, SwitchRow } from "@/pages/settings/parts";
import { SECTION_PATHS } from "@/pages/settings/sections";
import { useSettingsSection } from "@/pages/settings/useSettingsSection";

type ListKey = "allowedEmails" | "adminEmails" | "githubUsers";

function SignupForm({ settings }: { settings: UiSettings }) {
  const sec = useSettingsSection(settings, SECTION_PATHS.signup);
  const f = sec.form;
  const s = sec.base;
  const locked = (path: FieldPath) => !!lockedHint(s, path);
  const hint = (path: FieldPath, normal: string) => lockedHint(s, path) ?? normal;
  const off = !f.autoProvision;
  const list = (k: ListKey, path: FieldPath) => ({
    id: `auth-${k}`,
    value: f[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => sec.set(k, e.target.value, path),
    disabled: locked(path) || off,
    "aria-invalid": sec.errors[path] ? true : undefined,
    spellCheck: false,
    autoComplete: "off",
  });
  const anyProviderOn = (["oidc", "google", "github"] as const).some((id) => s.auth.methods?.[id]?.value);

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void sec.save();
      }}
    >
      <SwitchRow
        id="auth-autoProvision"
        label="Пускать без приглашения"
        description={hint(
          P.autoProvision,
          "Если человек входит через Google, GitHub или OpenID Connect и есть в списках ниже, панель сама создаст ему аккаунт.",
        )}
        checked={f.autoProvision}
        onChange={(v) => sec.set("autoProvision", v, P.autoProvision)}
        disabled={locked(P.autoProvision)}
      />
      <Field label="Роль новых пользователей" htmlFor="auth-defaultRole" hint={hint(P.defaultRole, ROLE_HINTS[f.defaultRole])}>
        <Select value={f.defaultRole} onValueChange={(v) => sec.set("defaultRole", v as Role, P.defaultRole)} disabled={locked(P.defaultRole) || off}>
          <SelectTrigger id="auth-defaultRole" className="sm:w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {ROLE_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Разрешённые e-mail"
          htmlFor="auth-allowedEmails"
          error={sec.errors[P.allowedEmails]}
          hint={hint(P.allowedEmails, "Через запятую. Только адреса, подтверждённые у провайдера")}
        >
          <Input {...list("allowedEmails", P.allowedEmails)} placeholder="me@example.com" />
        </Field>
        <Field
          label="E-mail администраторов"
          htmlFor="auth-adminEmails"
          error={sec.errors[P.adminEmails]}
          hint={hint(P.adminEmails, "Тоже пускаются, но сразу с ролью «Админ»")}
        >
          <Input {...list("adminEmails", P.adminEmails)} placeholder="admin@example.com" />
        </Field>
        <Field label="Логины GitHub" htmlFor="auth-githubUsers" error={sec.errors[P.githubUsers]} hint={hint(P.githubUsers, "Через запятую, регистр не важен")}>
          <Input {...list("githubUsers", P.githubUsers)} placeholder="octocat" />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">Группы OpenID Connect задаются в его настройках на вкладке «Вход».</p>
      {f.autoProvision && anyProviderOn && allowListsEmpty(f) && (
        <Callout variant="warning" title="Пока без приглашения не войдёт никто">
          Списки пусты, а пускать всех подряд небезопасно: войти смог бы любой владелец аккаунта Google или GitHub. Добавьте адреса или
          приглашайте людей кнопкой «Пригласить».
        </Callout>
      )}
      <SectionFooter dirty={sec.dirty} invalid={sec.invalid} saving={sec.saving} error={sec.generalError} onReset={sec.reset} />
    </form>
  );
}

/** «Регистрация без приглашения»: auto-provisioning through providers and its allow-lists. */
export function SignupSection() {
  const query = useQuery({ queryKey: qk.uiSettings, queryFn: () => serverApi.getSettings(), refetchOnWindowFocus: false });
  return (
    <Section
      id="auth-signup"
      title="Регистрация без приглашения"
      icon={UserPlus}
      description="Кого пускать, если человек сам входит через внешний аккаунт. Приглашённым эти настройки не нужны."
    >
      {query.data ? (
        <SignupForm settings={query.data} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <Skeleton className="h-40 w-full rounded-lg" />
      )}
    </Section>
  );
}
