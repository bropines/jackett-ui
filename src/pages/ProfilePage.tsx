import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Link2, Loader2, MonitorSmartphone, Save, Unlink, UserRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { ApiError, errText, providerLinkUrl, qk, serverApi, type Identity, type Me, type ProviderId } from "@/api";
import { ProviderIcon } from "@/components/auth/ProviderIcon";
import { RoleBadge } from "@/components/auth/RoleBadge";
import { Callout, ConfirmDialog, ErrorState, Field, Mono, PageHeader, RelativeTime } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { authErrorText, EMAIL_MAX, emailError, MIN_PASSWORD, newPasswordError, normalizeEmail, PROVIDER_NAMES } from "@/lib/auth";
import { useAuthErrorParam, useLinkedParam } from "@/lib/auth-hooks";
import { authStateQuery, resetSession } from "@/lib/auth-query";
import { PasskeysCard } from "@/pages/profile/PasskeysCard";
import { TokensCard } from "@/pages/profile/TokensCard";
import { Section, SecretInput } from "@/pages/settings/parts";

function NameCard({ me }: { me: Me }) {
  const qc = useQueryClient();
  const curName = me.user.name ?? "";
  const curEmail = me.user.email ?? "";
  const [name, setName] = useState(curName);
  const [email, setEmail] = useState(curEmail);
  const [touched, setTouched] = useState(false);
  useEffect(() => setName(curName), [curName]);
  useEffect(() => setEmail(curEmail), [curEmail]);
  const nameDirty = name.trim() !== curName;
  const emailDirty = normalizeEmail(email) !== curEmail;
  const save = useMutation({
    mutationFn: () => serverApi.updateMe({ ...(nameDirty ? { name: name.trim() } : {}), ...(emailDirty ? { email: normalizeEmail(email) } : {}) }),
    onSuccess: () => {
      toast.success("Сохранено");
      setTouched(false);
      void qc.invalidateQueries({ queryKey: qk.me });
      void qc.invalidateQueries({ queryKey: qk.authState });
    },
  });
  const dirty = nameDirty || emailDirty;
  const emailErr = emailError(email);
  const err = save.isError ? save.error : undefined;
  const serverEmailErr = err instanceof ApiError && (err.code === "email_taken" || err.code === "invalid_email" || err.field === "email") ? errText(err) : undefined;
  return (
    <Section id="account" title="Учётная запись" icon={UserRound}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Имя пользователя:</span>
        <Mono>{me.user.username}</Mono>
        <RoleBadge role={me.user.role} />
      </div>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (dirty && !emailErr && !save.isPending) save.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Имя" htmlFor="me-name">
            <Input id="me-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoComplete="name" />
          </Field>
          <Field label="Почта" htmlFor="me-email" error={(touched ? emailErr : undefined) ?? serverEmailErr} hint="Необязательно. Пусто — удалить">
            <Input
              id="me-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={EMAIL_MAX}
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={(touched && emailErr) || serverEmailErr ? true : undefined}
            />
          </Field>
        </div>
        {err && !serverEmailErr && <Callout variant="error">{errText(err)}</Callout>}
        <Button type="submit" variant="outline" disabled={!dirty || save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Сохранить
        </Button>
      </form>
    </Section>
  );
}

function PasswordCard({ me, passwordLogin }: { me: Me; passwordLogin: boolean }) {
  const qc = useQueryClient();
  const hasPassword = me.user.passwordSet !== false;
  const [current, setCurrent] = useState("");
  const [pw, setPw] = useState("");
  const [repeat, setRepeat] = useState("");
  const [touched, setTouched] = useState(false);
  const change = useMutation({
    mutationFn: () => serverApi.changeMyPassword(hasPassword ? { current, new: pw } : { new: pw }),
    onSuccess: () => {
      toast.success(hasPassword ? "Пароль изменён, другие сеансы завершены" : "Пароль задан");
      setCurrent("");
      setPw("");
      setRepeat("");
      setTouched(false);
      void qc.invalidateQueries({ queryKey: qk.me });
      void qc.invalidateQueries({ queryKey: qk.authState });
    },
  });
  const err = newPasswordError(pw, repeat);
  const currentErr = hasPassword && !current ? "Введите текущий пароль" : undefined;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (err || currentErr || change.isPending) return;
    change.mutate();
  };

  return (
    <Section
      id="password"
      title={hasPassword ? "Смена пароля" : "Пароль"}
      icon={KeyRound}
      description={passwordLogin ? undefined : "Вход по паролю сейчас выключен администратором; пароль пригодится, если его включат."}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <input type="text" name="username" autoComplete="username" value={me.user.username} readOnly hidden />
        <div className="grid gap-4 sm:grid-cols-3">
          {hasPassword && (
            <Field label="Текущий пароль" htmlFor="me-pw-current" error={touched ? currentErr : undefined}>
              <SecretInput id="me-pw-current" value={current} onChange={setCurrent} autoComplete="current-password" invalid={touched && !!currentErr} />
            </Field>
          )}
          <Field label="Новый пароль" htmlFor="me-pw-new" error={touched && pw.length < MIN_PASSWORD ? err : undefined} hint={`Не короче ${MIN_PASSWORD} символов`}>
            <SecretInput id="me-pw-new" value={pw} onChange={setPw} autoComplete="new-password" />
          </Field>
          <Field label="Ещё раз" htmlFor="me-pw-repeat" error={touched && pw.length >= MIN_PASSWORD ? err : undefined}>
            <SecretInput id="me-pw-repeat" value={repeat} onChange={setRepeat} autoComplete="new-password" />
          </Field>
        </div>
        {change.isError && <Callout variant="error">{errText(change.error)}</Callout>}
        <Button type="submit" variant="outline" disabled={change.isPending}>
          {change.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />} {hasPassword ? "Сменить пароль" : "Задать пароль"}
        </Button>
      </form>
    </Section>
  );
}

function IdentitiesCard({ me, providers }: { me: Me; providers: { id: ProviderId; name: string }[] }) {
  const qc = useQueryClient();
  const authError = useAuthErrorParam();
  const linked = useLinkedParam();
  const [toUnlink, setToUnlink] = useState<Identity | null>(null);
  const unlink = useMutation({
    mutationFn: (i: Identity) => serverApi.unlinkMyIdentity(i.provider),
    onSuccess: () => {
      setToUnlink(null);
      toast.success("Аккаунт отвязан");
      void qc.invalidateQueries({ queryKey: qk.me });
    },
    onError: () => setToUnlink(null),
  });

  // Every enabled provider, plus linked identities of providers that are now off.
  const rows: { id: ProviderId; name: string; identity?: Identity; enabled: boolean }[] = providers.map((p) => ({
    ...p,
    identity: me.identities.find((i) => i.provider === p.id),
    enabled: true,
  }));
  for (const i of me.identities) {
    if (!rows.some((r) => r.id === i.provider)) rows.push({ id: i.provider, name: PROVIDER_NAMES[i.provider] ?? i.provider, identity: i, enabled: false });
  }

  return (
    <Section id="identities" title="Привязанные аккаунты" icon={Link2} description="Чтобы входить через внешнего провайдера в эту же учётную запись.">
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
      {unlink.isError && <Callout variant="error">{errText(unlink.error)}</Callout>}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Внешний вход не включён администратором.</p>
      ) : (
        <ul className="divide-y rounded-md border" aria-label="Привязанные аккаунты">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <ProviderIcon id={r.id} className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{r.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {r.identity ? (
                    <>
                      {r.identity.label} · привязан <RelativeTime iso={r.identity.linkedAt} />
                    </>
                  ) : (
                    "не привязан"
                  )}
                  {!r.enabled && " · способ входа выключен"}
                </div>
              </div>
              {r.identity ? (
                <Button variant="outline" size="sm" onClick={() => setToUnlink(r.identity!)}>
                  <Unlink /> Отвязать
                </Button>
              ) : (
                <Button asChild variant="outline" size="sm">
                  <a href={providerLinkUrl(r.id)}>
                    <Link2 /> Привязать
                  </a>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={toUnlink !== null}
        onOpenChange={(o) => !o && !unlink.isPending && setToUnlink(null)}
        title={`Отвязать ${toUnlink ? (PROVIDER_NAMES[toUnlink.provider] ?? toUnlink.provider) : ""}?`}
        description="Входить через этот аккаунт больше не получится. Привязать его можно снова."
        confirmLabel="Отвязать"
        destructive
        pending={unlink.isPending}
        onConfirm={() => toUnlink && unlink.mutate(toUnlink)}
      />
    </Section>
  );
}

function SessionsCard() {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const all = useMutation({
    mutationFn: () => serverApi.logoutAll(),
    onSettled: () => void resetSession(qc),
    onError: (e) => toast.error(errText(e)),
  });
  return (
    <Section id="sessions" title="Сеансы" icon={MonitorSmartphone}>
      <p className="text-sm text-muted-foreground">Завершит все ваши сеансы, включая этот. API-токены продолжат работать.</p>
      <div>
        <Button variant="outline" onClick={() => setConfirm(true)}>
          <MonitorSmartphone /> Выйти на всех устройствах
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Выйти на всех устройствах?"
        description="Придётся войти заново везде, в том числе здесь."
        confirmLabel="Выйти везде"
        pending={all.isPending}
        onConfirm={() => all.mutate()}
      />
    </Section>
  );
}

/** `/profile`: own account, password, passkeys, linked accounts, API tokens, sessions. */
export function ProfilePage() {
  const { data: auth } = useQuery(authStateQuery);
  const q = useQuery({ queryKey: qk.me, queryFn: () => serverApi.me(), enabled: !auth?.disabled });

  useEffect(() => {
    if (q.data && window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, [q.data]);

  if (auth?.disabled) {
    return (
      <>
        <PageHeader title="Профиль" />
        <Callout variant="warning">Вход отключён: профиля нет. Включите вход в настройках панели.</Callout>
      </>
    );
  }

  let body: React.ReactNode;
  if (q.isPending) {
    body = (
      <div className="space-y-4">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-32 w-full rounded-xl" />
        ))}
      </div>
    );
  } else if (q.isError) {
    body = <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  } else {
    const me = q.data;
    body = (
      <div className="space-y-4">
        <NameCard me={me} />
        <TokensCard tokens={me.tokens ?? []} />
        <PasswordCard me={me} passwordLogin={auth?.methods.password ?? true} />
        <PasskeysCard />
        <IdentitiesCard me={{ ...me, identities: me.identities ?? [] }} providers={auth?.methods.providers ?? []} />
        <SessionsCard />
      </div>
    );
  }

  return (
    <div className="mx-auto min-w-0 max-w-3xl">
      <PageHeader title="Профиль" description={auth?.user ? auth.user.name || auth.user.username : undefined} />
      {body}
    </div>
  );
}
