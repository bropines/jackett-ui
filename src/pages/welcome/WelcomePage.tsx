import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, CheckCircle2, Fingerprint, KeyRound, Link2, Power, Settings2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { errText, PROVIDER_IDS, providerLinkUrl, qk, serverApi, type MethodId, type ProviderId, type UiSettings } from "@/api";
import { AddPasskeyDialog, PasskeyUnavailable } from "@/components/auth/passkey";
import { usePasskeyAvailability } from "@/lib/passkey";
import { ProviderIcon } from "@/components/auth/ProviderIcon";
import { Callout, PageHeader } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { authErrorText, PROVIDER_NAMES, WELCOME_PATH } from "@/lib/auth";
import { useAuthErrorParam, useCan, useLinkedParam } from "@/lib/auth-hooks";
import { authStateQuery } from "@/lib/auth-query";
import { lockedHint, P } from "@/pages/settings/auth/logic";
import { enableMethodPatch, providerStatus } from "@/pages/welcome/logic";
import { MethodCard } from "@/pages/welcome/MethodCard";
import { ProviderSetupDialog } from "@/pages/welcome/ProviderSetupDialog";

export interface WelcomePageSearch {
  step?: string;
  linked?: string;
  authError?: string;
}

const PROVIDER_TITLES: Record<ProviderId, string> = { oidc: "OpenID Connect", google: "Google", github: "GitHub" };

function Yes({ children }: { children: string }) {
  return (
    <Badge variant="success" className="gap-1">
      <CheckCircle2 className="h-3 w-3" aria-hidden /> {children}
    </Badge>
  );
}
const No = ({ children }: { children: string }) => <Badge variant="outline">{children}</Badge>;

/** `/welcome?step=methods`: set up login methods right after creating the account (reachable any time). */
export function WelcomePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: auth } = useQuery(authStateQuery);
  const admin = useCan("admin");
  const off = !!auth?.disabled;
  const me = useQuery({ queryKey: qk.me, queryFn: () => serverApi.me(), enabled: !off });
  const passkeys = useQuery({ queryKey: qk.myPasskeys, queryFn: () => serverApi.myPasskeys(), enabled: !off });
  const settings = useQuery({ queryKey: qk.uiSettings, queryFn: () => serverApi.getSettings(), enabled: admin, refetchOnWindowFocus: false });
  const availability = usePasskeyAvailability();
  const authError = useAuthErrorParam();
  const linked = useLinkedParam();
  const [addPasskey, setAddPasskey] = useState(false);
  const [setupFor, setSetupFor] = useState<ProviderId | null>(null);

  const enable = useMutation({
    mutationFn: ({ s, id }: { s: UiSettings; id: MethodId }) => serverApi.putSettings(enableMethodPatch(s, id)),
    onSuccess: () => {
      toast.success("Вход включён");
      void qc.invalidateQueries({ queryKey: qk.uiSettings });
      void qc.invalidateQueries({ queryKey: qk.authState });
    },
    onError: (e) => toast.error(errText(e)),
  });

  const done = (
    <div className="flex justify-end">
      <Button onClick={() => void navigate({ to: "/" })}>
        <Check /> Готово
      </Button>
    </div>
  );

  if (off) {
    return (
      <div className="mx-auto min-w-0 max-w-3xl space-y-4">
        <PageHeader title="Способы входа" />
        <Callout variant="warning">Вход отключён: настраивать нечего. Включите вход в настройках панели.</Callout>
        {done}
      </div>
    );
  }

  const s = settings.data;
  const methodsLock = s ? lockedHint(s, P.methods) : undefined;
  const passwordSet = me.data ? me.data.user.passwordSet !== false : undefined;
  const identities = me.data?.identities ?? [];
  const count = passkeys.data?.length ?? 0;

  const enableButton = (id: MethodId) =>
    s &&
    !methodsLock && (
      <Button size="sm" onClick={() => enable.mutate({ s, id })} disabled={enable.isPending}>
        <Power /> Включить вход
      </Button>
    );

  return (
    <div className="mx-auto min-w-0 max-w-3xl space-y-4">
      <PageHeader title="Способы входа" description="Как вы будете входить в панель. Всё это можно изменить позже в профиле и настройках." />

      {authError && (
        <Callout variant="error" title="Не удалось привязать">
          {authErrorText(authError)}
        </Callout>
      )}
      {linked && !authError && (
        <Callout variant="info" title="Аккаунт привязан">
          {PROVIDER_NAMES[linked as ProviderId] ?? linked}: теперь можно входить и через него.
        </Callout>
      )}

      <MethodCard
        id="welcome-password"
        icon={<KeyRound className="h-4 w-4" aria-hidden />}
        title="Пароль"
        badges={passwordSet === undefined ? null : passwordSet ? <Yes>задан</Yes> : <No>не задан</No>}
        actions={
          passwordSet === false && (
            <Button asChild size="sm" variant="outline">
              <Link to="/profile" hash="password">
                Задать пароль
              </Link>
            </Button>
          )
        }
      >
        {auth && !auth.methods.password && <p>Вход по паролю сейчас выключен.</p>}
      </MethodCard>

      <MethodCard
        id="welcome-passkey"
        icon={<Fingerprint className="h-4 w-4" aria-hidden />}
        title="Passkey"
        badges={
          <>
            {passkeys.data && (count > 0 ? <Yes>{`добавлено: ${count}`}</Yes> : <No>нет</No>)}
            {availability.methodOn === true && <Yes>вход включён</Yes>}
            {availability.methodOn === false && <No>вход выключен</No>}
          </>
        }
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setAddPasskey(true)} disabled={!availability.browser}>
              <Fingerprint /> Добавить passkey
            </Button>
            {availability.methodOn === false && enableButton("passkey")}
          </>
        }
      >
        <p>Вход без пароля: отпечаток, Face ID, PIN или ключ безопасности.</p>
        {passkeys.data && count > 0 && <p>{passkeys.data.map((p) => p.name).join(", ")}</p>}
        <PasskeyUnavailable availability={availability} />
      </MethodCard>

      {admin && settings.isPending && <Skeleton className="h-32 w-full rounded-xl" />}
      {admin && settings.isError && <Callout variant="error">{errText(settings.error)}</Callout>}
      {admin &&
        s &&
        PROVIDER_IDS.map((id) => {
          const st = providerStatus(s, id);
          const identity = identities.find((i) => i.provider === id);
          const name = id === "oidc" ? s.auth.providers.oidc.providerName.value || PROVIDER_TITLES.oidc : PROVIDER_TITLES[id];
          return (
            <MethodCard
              key={id}
              id={`welcome-${id}`}
              icon={<ProviderIcon id={id} className="h-4 w-4" />}
              title={name}
              badges={
                <>
                  {st.configured ? <Yes>настроен</Yes> : <No>не настроен</No>}
                  {st.configured && (st.verified ? <Yes>проверен</Yes> : <No>не проверен</No>)}
                  {st.on ? <Yes>вход включён</Yes> : <No>вход выключен</No>}
                </>
              }
              actions={
                <>
                  <Button size="sm" variant="outline" onClick={() => setSetupFor(id)}>
                    <Settings2 /> Настроить
                  </Button>
                  {st.verified && !st.on && enableButton(id)}
                  {st.verified && st.on && !identity && (
                    <Button asChild size="sm" variant="outline">
                      <a href={providerLinkUrl(id, WELCOME_PATH)}>
                        <Link2 /> Привязать к моему аккаунту
                      </a>
                    </Button>
                  )}
                </>
              }
            >
              {identity && <p>Привязан: {identity.label}</p>}
              {!st.verified && st.configured && <p>Нажмите «Настроить» и проверьте вход у провайдера.</p>}
              {st.verified && !st.on && methodsLock && <p>Включить отсюда нельзя: {methodsLock}.</p>}
            </MethodCard>
          );
        })}

      {done}

      <AddPasskeyDialog open={addPasskey} onOpenChange={setAddPasskey} />
      {setupFor && s && <ProviderSetupDialog id={setupFor} settings={s} onClose={() => setSetupFor(null)} />}
    </div>
  );
}
