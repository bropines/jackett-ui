import { useQuery } from "@tanstack/react-query";
import { Clock, Globe } from "lucide-react";

import { qk, serverApi, type UiSettings } from "@/api";
import { ErrorState, Field } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { lockedHint, P } from "@/pages/settings/auth/logic";
import { Section, SectionFooter } from "@/pages/settings/parts";
import { durationText, SECTION_PATHS } from "@/pages/settings/sections";
import { useSettingsSection } from "@/pages/settings/useSettingsSection";

const TTL_PRESETS = [
  { value: "24h", label: "Сутки" },
  { value: "168h", label: "Неделя" },
  { value: "720h", label: "30 дней" },
];

function GeneralForm({ settings }: { settings: UiSettings }) {
  const sec = useSettingsSection(settings, SECTION_PATHS.general);
  const s = sec.base;
  const urlLock = lockedHint(s, P.publicUrl);
  const ttlLock = lockedHint(s, P.sessionTtl);
  const ttl = durationText(sec.form.sessionTtl);

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void sec.save();
      }}
    >
      <Section id="general-url" title="Внешний адрес" icon={Globe} description="Адрес, по которому панель открывают из браузера.">
        <Field
          label="Адрес панели"
          htmlFor="auth-publicUrl"
          error={sec.errors[P.publicUrl]}
          hint={
            urlLock ??
            "Нужен для ссылок-приглашений, входа через Google, GitHub, OpenID Connect и для passkey. Пусто — берётся из адреса запроса."
          }
        >
          <Input
            id="auth-publicUrl"
            type="url"
            value={sec.form.publicUrl}
            onChange={(e) => sec.set("publicUrl", e.target.value, P.publicUrl)}
            disabled={!!urlLock}
            aria-invalid={sec.errors[P.publicUrl] ? true : undefined}
            placeholder="https://jackett.example.com"
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
      </Section>

      <Section id="general-session" title="Сеанс" icon={Clock} description="Сколько держится вход, прежде чем снова спросить пароль.">
        <Field
          label="Время жизни сеанса"
          htmlFor="auth-sessionTtl"
          error={sec.errors[P.sessionTtl]}
          hint={ttlLock ?? (ttl ? `${ttl}. Формат: 24h, 168h, 30m` : "Формат: 24h, 168h, 30m. Пусто — неделя")}
        >
          <div className="flex flex-wrap gap-2">
            <Input
              id="auth-sessionTtl"
              value={sec.form.sessionTtl}
              onChange={(e) => sec.set("sessionTtl", e.target.value, P.sessionTtl)}
              disabled={!!ttlLock}
              aria-invalid={sec.errors[P.sessionTtl] ? true : undefined}
              placeholder="168h"
              spellCheck={false}
              autoComplete="off"
              className="w-32"
            />
            {!ttlLock &&
              TTL_PRESETS.map((p) => (
                <Button
                  key={p.value}
                  type="button"
                  variant={sec.form.sessionTtl.trim() === p.value ? "secondary" : "outline"}
                  size="sm"
                  className="h-9"
                  aria-pressed={sec.form.sessionTtl.trim() === p.value}
                  onClick={() => sec.set("sessionTtl", p.value, P.sessionTtl)}
                >
                  {p.label}
                </Button>
              ))}
          </div>
        </Field>
      </Section>

      <SectionFooter dirty={sec.dirty} invalid={sec.invalid} saving={sec.saving} error={sec.generalError} onReset={sec.reset} />
    </form>
  );
}

/** «Общее»: public address and session lifetime. */
export function GeneralTab() {
  const query = useQuery({ queryKey: qk.uiSettings, queryFn: () => serverApi.getSettings(), refetchOnWindowFocus: false });
  if (query.data) return <GeneralForm settings={query.data} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <Skeleton className="h-64 w-full rounded-xl" />;
}
