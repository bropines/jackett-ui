import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fingerprint, KeyRound, Settings2, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ApiError, errText, PROVIDER_IDS, qk, serverApi, type MethodId, type ProviderId, type UiSettings } from "@/api";
import { ProviderIcon } from "@/components/auth/ProviderIcon";
import { Callout, ErrorState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { isLocked, lockedHint, P } from "@/pages/settings/auth/logic";
import { DangerZone } from "@/pages/settings/login/DangerZone";
import { MethodCard, No, Yes } from "@/pages/settings/login/MethodCard";
import { methodErrorTarget, methodPatch, methodState, type SettingsTab } from "@/pages/settings/sections";
import { ProviderSetupDialog } from "@/pages/welcome/ProviderSetupDialog";

const PROVIDER_TEXT: Record<ProviderId, { title: string; description: string }> = {
  oidc: { title: "OpenID Connect", description: "Свой сервер входа: Authentik, Keycloak, Authelia, Pocket ID и т. п." },
  google: { title: "Google", description: "Вход через аккаунт Google." },
  github: { title: "GitHub", description: "Вход через аккаунт GitHub." },
};

export function methodTitle(s: UiSettings, id: MethodId): string {
  if (id === "password") return "Пароль";
  if (id === "passkey") return "Passkey";
  if (id === "header") return "Вход через прокси";
  if (id === "oidc") return s.auth.providers.oidc.providerName.value || PROVIDER_TEXT.oidc.title;
  return PROVIDER_TEXT[id].title;
}

/** Switching one login method on/off: saves at once, errors go to that method's card. */
export function useMethodToggle(s: UiSettings | undefined) {
  const qc = useQueryClient();
  const [errors, setErrors] = useState<Partial<Record<MethodId, string>>>({});
  const toggle = useMutation({
    mutationFn: ({ id, on }: { id: MethodId; on: boolean }) => serverApi.putSettings(methodPatch(s!, id, on)),
    onMutate: () => setErrors({}),
    onSuccess: async (_r, { id, on }) => {
      toast.success(`${methodTitle(s!, id)}: вход ${on ? "включён" : "выключен"}`);
      await qc.invalidateQueries({ queryKey: qk.uiSettings });
      void qc.invalidateQueries({ queryKey: qk.authState });
    },
    onError: (e, { id }) => setErrors({ [methodErrorTarget(e instanceof ApiError ? e.field : undefined, id)]: errText(e) }),
  });
  return { errors, pending: toggle.isPending, toggle: (id: MethodId, on: boolean) => toggle.mutate({ id, on }) };
}

/** «Вход»: login methods as cards with switches; header login and «turn login off» below. */
export function LoginTab({ onOpenTab }: { onOpenTab?: (tab: SettingsTab) => void }) {
  const query = useQuery({ queryKey: qk.uiSettings, queryFn: () => serverApi.getSettings(), refetchOnWindowFocus: false });
  const s = query.data;
  const methods = useMethodToggle(s);
  const [setupFor, setSetupFor] = useState<ProviderId | null>(null);

  if (query.isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>
    );
  }
  if (!s) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const card = (id: MethodId) => {
    const st = methodState(s, id);
    return {
      on: st.on,
      canToggle: st.canToggle && !methods.pending,
      onToggle: (on: boolean) => methods.toggle(id, on),
      error: methods.errors[id],
    };
  };
  const methodsLock = isLocked(s, P.methods) ? lockedHint(s, P.methods) : undefined;
  const passkeyOff = s.auth.passkey && !s.auth.passkey.available;

  return (
    <div className="space-y-6">
      {s.auth.disabled?.value && (
        <Callout variant="error" title="Вход отключён">
          Любой, кто откроет адрес панели, работает как администратор. Включить вход обратно можно внизу страницы.
        </Callout>
      )}
      {methodsLock && <Callout variant="info">Способы входа {methodsLock}: здесь их не переключить.</Callout>}

      <section className="space-y-3" aria-labelledby="login-methods-title">
        <h2 id="login-methods-title" className="sr-only">
          Способы входа
        </h2>
        <MethodCard
          id="method-password"
          icon={<KeyRound className="h-4 w-4" aria-hidden />}
          title="Пароль"
          description="Имя пользователя и пароль. Каждый задаёт пароль в своём профиле."
          switchLabel="Вход по паролю"
          {...card("password")}
        />

        <MethodCard
          id="method-passkey"
          icon={<Fingerprint className="h-4 w-4" aria-hidden />}
          title="Passkey"
          description="Вход без пароля: отпечаток, Face ID, PIN или ключ безопасности. Passkey добавляют в профиле."
          badges={passkeyOff ? <No>не работает на этом адресе</No> : undefined}
          switchLabel="Вход по passkey"
          {...card("passkey")}
          actions={
            passkeyOff &&
            onOpenTab && (
              <Button size="sm" variant="outline" onClick={() => onOpenTab("general")}>
                Указать внешний адрес
              </Button>
            )
          }
        >
          {passkeyOff && (
            <p className="text-amber-700 dark:text-amber-300">{s.auth.passkey?.reason || "Нужен https-адрес с доменным именем (внешний адрес на вкладке «Общее»)."}</p>
          )}
        </MethodCard>

        {PROVIDER_IDS.map((id) => {
          const st = methodState(s, id);
          const title = methodTitle(s, id);
          return (
            <MethodCard
              key={id}
              id={`method-${id}`}
              icon={<ProviderIcon id={id} className="h-4 w-4" />}
              title={title}
              description={PROVIDER_TEXT[id].description}
              badges={
                <>
                  {st.configured ? <Yes>настроен</Yes> : <No>не настроен</No>}
                  {st.configured && (st.verified ? <Yes>проверен</Yes> : <No>не проверен</No>)}
                </>
              }
              switchLabel={`Вход через ${title}`}
              {...card(id)}
              actions={
                <Button size="sm" variant="outline" onClick={() => setSetupFor(id)}>
                  <Settings2 /> Настроить
                </Button>
              }
            >
              {!st.on && !st.canToggle && st.reason && !s.auth.disabled?.value && !methodsLock && <p>{st.reason}, затем включите.</p>}
            </MethodCard>
          );
        })}

        <div className="flex flex-col gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground sm:flex-row sm:items-center">
          <p className="min-w-0 flex-1">
            Через Google, GitHub и OpenID Connect входят приглашённые и те, кто привязал аккаунт в профиле. Пускать людей без приглашения можно на вкладке
            «Пользователи».
          </p>
          {onOpenTab && (
            <Button size="sm" variant="outline" className="shrink-0" onClick={() => onOpenTab("users")}>
              <Users /> Пользователи
            </Button>
          )}
        </div>
      </section>

      <DangerZone settings={s} headerCard={card("header")} />

      {setupFor && <ProviderSetupDialog id={setupFor} settings={s} onClose={() => setSetupFor(null)} />}
    </div>
  );
}
