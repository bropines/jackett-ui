import { CheckCircle2, ExternalLink, Github, Loader2, LogIn, RotateCcw, X } from "lucide-react";
import type { ReactNode } from "react";

import type { ProviderId, UiSettings } from "@/api";
import { Callout, CopyField, Field } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { lockedHint, P, type AuthErrors, type ProviderForm } from "@/pages/settings/auth/logic";
import { SecretInput } from "@/pages/settings/parts";

export type TestState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "waiting"; url: string; popupBlocked: boolean }
  | { status: "failed"; message: string }
  | { status: "timeout" };

const TITLES: Record<ProviderId, { title: string; description: ReactNode }> = {
  oidc: {
    title: "OpenID Connect",
    description: "Свой провайдер: Authentik, Keycloak, Authelia, Pocket ID и т. п.",
  },
  google: { title: "Google", description: "Клиент OAuth в Google Cloud Console (тип «Веб-приложение»)." },
  github: { title: "GitHub", description: "OAuth App в настройках GitHub (Settings → Developer settings)." },
};

export function ProviderSection({
  id,
  form,
  settings,
  errors,
  verified,
  test,
  onChange,
  onTest,
  onCancelTest,
}: {
  id: ProviderId;
  form: ProviderForm;
  settings: UiSettings;
  errors: AuthErrors;
  verified: boolean;
  test: TestState;
  onChange: (patch: Partial<ProviderForm>) => void;
  onTest: () => void;
  onCancelTest: () => void;
}) {
  const sp = settings.auth.providers[id];
  const path = (f: Parameters<typeof P.provider>[1]) => P.provider(id, f);
  const lockHint = (f: Parameters<typeof P.provider>[1]) => lockedHint(settings, path(f));
  const locked = (f: Parameters<typeof P.provider>[1]) => !!lockHint(f);
  const enabled = form.clientId.trim() !== "";
  const secretSet = sp.clientSecretSet.value;
  const testing = test.status === "starting" || test.status === "waiting";
  const t = TITLES[id];

  const text = (f: "clientId" | "issuer" | "providerName" | "scopes" | "allowedGroups" | "groupsClaim", extra: React.ComponentProps<typeof Input> = {}) => ({
    id: `auth-${id}-${f}`,
    value: form[f],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange({ [f]: e.target.value }),
    disabled: locked(f),
    "aria-invalid": errors[path(f)] ? true : undefined,
    spellCheck: false,
    autoComplete: "off",
    ...extra,
  });

  return (
    <section className="space-y-4 rounded-lg border p-3 md:p-4" aria-labelledby={`auth-${id}-title`}>
      <div className="flex flex-wrap items-center gap-2">
        {id === "github" ? <Github className="h-4 w-4 text-muted-foreground" aria-hidden /> : <LogIn className="h-4 w-4 text-muted-foreground" aria-hidden />}
        <h4 id={`auth-${id}-title`} className="text-sm font-semibold">
          {t.title}
        </h4>
        {!enabled && <Badge variant="outline">не настроен</Badge>}
        {enabled && verified && (
          <Badge variant="success" className="gap-1">
            <CheckCircle2 className="h-3 w-3" aria-hidden /> проверено
          </Badge>
        )}
        {enabled && !verified && <Badge variant="secondary">не проверен</Badge>}
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">{t.description}</p>

      <Field label="Адрес возврата (Redirect URI)" hint="Укажите его в настройках клиента у провайдера.">
        <CopyField value={sp.redirectUrl} label={`Копировать адрес возврата ${t.title}`} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        {id === "oidc" && (
          <Field
            label="Issuer"
            htmlFor="auth-oidc-issuer"
            error={errors[path("issuer")]}
            hint={lockHint("issuer") ?? "Адрес провайдера, где есть /.well-known/openid-configuration"}
            className="sm:col-span-2"
          >
            <Input {...text("issuer", { type: "url", placeholder: "https://auth.example.com/application/o/jackett/" })} />
          </Field>
        )}
        <Field label="Client ID" htmlFor={`auth-${id}-clientId`} error={errors[path("clientId")]} hint={lockHint("clientId") ?? "Пусто — провайдер выключен"}>
          <Input {...text("clientId")} />
        </Field>
        <Field
          label={
            <span className="inline-flex items-center gap-2">
              Client secret
              {secretSet && !form.clearSecret && (
                <Badge variant="secondary" className="px-1.5 py-0 text-[0.6875rem] font-medium">
                  задан
                </Badge>
              )}
            </span>
          }
          htmlFor={`auth-${id}-clientSecret`}
          error={errors[path("clientSecret")]}
          hint={lockHint("clientSecret") ?? (secretSet ? "Оставьте пустым, чтобы не менять" : undefined)}
        >
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <SecretInput
                id={`auth-${id}-clientSecret`}
                value={form.clientSecret}
                onChange={(v) => onChange(v ? { clientSecret: v, clearSecret: false } : { clientSecret: v })}
                disabled={locked("clientSecret") || form.clearSecret}
                placeholder={secretSet ? (form.clearSecret ? "будет удалён" : "••••••••") : ""}
                autoComplete="new-password"
              />
            </div>
            {secretSet && !locked("clientSecret") && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={form.clearSecret ? "Не удалять секрет" : "Удалить секрет"}
                title={form.clearSecret ? "Не удалять секрет" : "Удалить секрет"}
                aria-pressed={form.clearSecret}
                onClick={() => onChange({ clearSecret: !form.clearSecret, clientSecret: "" })}
              >
                {form.clearSecret ? <RotateCcw /> : <X />}
              </Button>
            )}
          </div>
        </Field>
        {id === "oidc" && (
          <>
            <Field label="Название на кнопке" htmlFor="auth-oidc-providerName" error={errors[path("providerName")]} hint={lockHint("providerName") ?? "«Войти через …», например Authentik"}>
              <Input {...text("providerName", { placeholder: "SSO" })} />
            </Field>
            <Field label="Scopes" htmlFor="auth-oidc-scopes" error={errors[path("scopes")]} hint={lockHint("scopes") ?? "Через пробел"}>
              <Input {...text("scopes", { placeholder: "openid email profile" })} />
            </Field>
            <Field
              label="Разрешённые группы"
              htmlFor="auth-oidc-allowedGroups"
              error={errors[path("allowedGroups")]}
              hint={lockHint("allowedGroups") ?? "Через запятую. Участники этих групп могут войти"}
            >
              <Input {...text("allowedGroups", { placeholder: "jackett-admins" })} />
            </Field>
            <Field label="Claim с группами" htmlFor="auth-oidc-groupsClaim" error={errors[path("groupsClaim")]} hint={lockHint("groupsClaim")}>
              <Input {...text("groupsClaim", { placeholder: "groups" })} />
            </Field>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onTest}
          disabled={testing || !enabled || (id === "oidc" && (!form.issuer.trim() || !!errors[path("issuer")]))}
        >
          {testing ? <Loader2 className="animate-spin" /> : <LogIn />}
          Проверить вход
        </Button>
        {test.status === "waiting" && (
          <>
            <span className="text-sm text-muted-foreground" role="status">
              Войдите у провайдера в открывшейся вкладке…
            </span>
            {test.popupBlocked && (
              <Button asChild variant="link" size="sm" className="h-auto px-0">
                <a href={test.url} target="_blank" rel="noopener noreferrer">
                  Открыть страницу входа <ExternalLink />
                </a>
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={onCancelTest}>
              Отменить
            </Button>
          </>
        )}
      </div>
      {test.status === "failed" && (
        <Callout variant="error" title="Проверка не пройдена">
          {test.message}
        </Callout>
      )}
      {test.status === "timeout" && <Callout variant="warning">Не дождался входа у провайдера. Попробуйте ещё раз.</Callout>}
    </section>
  );
}
