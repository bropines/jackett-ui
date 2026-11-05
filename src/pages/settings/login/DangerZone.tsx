import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Router, ShieldAlert, ShieldOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { errText, qk, serverApi, type UiSettings } from "@/api";
import { ConfirmDialog, Field } from "@/components/common";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/misc";
import { lockedHint, P } from "@/pages/settings/auth/logic";
import { MethodCard } from "@/pages/settings/login/MethodCard";
import { SectionFooter } from "@/pages/settings/parts";
import { methodState, SECTION_PATHS } from "@/pages/settings/sections";
import { useSettingsSection } from "@/pages/settings/useSettingsSection";

interface SwitchProps {
  on: boolean;
  canToggle: boolean;
  onToggle: (on: boolean) => void;
  error?: string;
}

/** Login through a reverse proxy header: switch saves at once, the fields with their own button. */
function HeaderCard({ settings, toggle }: { settings: UiSettings; toggle: SwitchProps }) {
  const sec = useSettingsSection(settings, SECTION_PATHS.header);
  const st = methodState(settings, "header");
  const hint = (path: string, normal: string) => lockedHint(settings, path) ?? normal;
  const input = (k: "headerName" | "headerTrusted", path: string) => ({
    id: `auth-${k}`,
    value: sec.form[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => sec.set(k, e.target.value, path),
    disabled: !!lockedHint(settings, path),
    "aria-invalid": sec.errors[path] ? true : undefined,
    spellCheck: false,
    autoComplete: "off",
  });

  return (
    <MethodCard
      id="method-header"
      icon={<Router className="h-4 w-4" aria-hidden />}
      title="Вход через прокси"
      description="Вход проверяет прокси перед панелью (Authelia, Authentik, oauth2-proxy) и передаёт имя пользователя в заголовке."
      switchLabel="Вход через прокси"
      {...toggle}
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void sec.save();
        }}
      >
        {!st.on && !st.configured && <p>Сначала укажите заголовок и адреса прокси, сохраните, затем включите.</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Имя заголовка" htmlFor="auth-headerName" error={sec.errors[P.headerName]} hint={hint(P.headerName, "Например Remote-User. Значение — имя пользователя в панели")}>
            <Input {...input("headerName", P.headerName)} placeholder="Remote-User" />
          </Field>
          <Field
            label="Адреса прокси"
            htmlFor="auth-headerTrusted"
            error={sec.errors[P.headerTrusted]}
            hint={hint(P.headerTrusted, "Сети через запятую, например 172.16.0.0/12. От других адресов заголовок не принимается")}
          >
            <Input {...input("headerTrusted", P.headerTrusted)} placeholder="172.16.0.0/12" />
          </Field>
        </div>
        <SectionFooter dirty={sec.dirty} invalid={sec.invalid} saving={sec.saving} error={sec.generalError} onReset={sec.reset} />
      </form>
    </MethodCard>
  );
}

/** «Отключить вход»: on → confirm first; off → saves at once. */
function DisableLoginCard({ settings }: { settings: UiSettings }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const on = !!settings.auth.disabled?.value;
  const lock = lockedHint(settings, P.disabled);

  const save = useMutation({
    mutationFn: (disabled: boolean) => serverApi.putSettings(disabled ? { auth: { disabled }, confirm: true } : { auth: { disabled } }),
    onMutate: () => setError(""),
    onSuccess: async (_r, disabled) => {
      setConfirm(false);
      toast.success(disabled ? "Вход отключён" : "Вход снова включён");
      await qc.invalidateQueries({ queryKey: qk.uiSettings });
      void qc.invalidateQueries({ queryKey: qk.authState });
    },
    onError: (e) => {
      setConfirm(false);
      setError(errText(e));
    },
  });

  return (
    <Card role="region" aria-labelledby="auth-disabled-title" className="space-y-2 border-destructive/40 p-4 shadow-none">
      <div className="flex items-start gap-3">
        <ShieldOff className="mt-0.5 h-4 w-4 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <h3 id="auth-disabled-title" className="text-sm font-semibold text-destructive">
            Отключить вход
          </h3>
          <p className="text-sm text-muted-foreground">
            {lock ?? "Панель откроется без пароля, и любой посетитель станет администратором. Только если панель уже закрыта другим способом."}
          </p>
        </div>
        <Switch
          id="auth-disabled"
          aria-label="Отключить вход"
          checked={on}
          disabled={!!lock || save.isPending}
          onCheckedChange={(v) => (v ? setConfirm(true) : save.mutate(false))}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive sm:pl-7">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={(o) => !save.isPending && setConfirm(o)}
        title="Отключить вход?"
        description="Любой, кто откроет адрес панели, станет администратором без пароля: сможет менять трекеры, видеть их пароли и управлять пользователями. Делайте это, только если панель доступна лишь в доверенной сети."
        confirmLabel="Отключить вход"
        destructive
        pending={save.isPending}
        onConfirm={() => save.mutate(true)}
      />
    </Card>
  );
}

/** Settings that can open the panel to strangers, kept apart from the normal methods. */
export function DangerZone({ settings, headerCard }: { settings: UiSettings; headerCard: SwitchProps }) {
  return (
    <section className="space-y-3" aria-labelledby="danger-title">
      <div className="space-y-0.5">
        <h2 id="danger-title" className="flex items-center gap-1.5 text-sm font-semibold">
          <ShieldAlert className="h-4 w-4 text-destructive" aria-hidden /> Осторожно
        </h2>
        <p className="text-xs text-muted-foreground">Ошибка здесь может открыть панель посторонним.</p>
      </div>
      <HeaderCard settings={settings} toggle={headerCard} />
      <DisableLoginCard settings={settings} />
    </section>
  );
}
