import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import {
  ApiError,
  errText,
  PROVIDER_IDS,
  providerTestToken,
  qk,
  serverApi,
  waitForProviderTest,
  type AuthMode,
  type ProviderId,
  type UiSettings,
  type UiSettingsPatch,
} from "@/api";
import { Callout, ConfirmDialog, ErrorState, Field } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem, Skeleton } from "@/components/ui/misc";
import { MIN_PASSWORD } from "@/lib/auth";
import {
  allowListsEmpty,
  anyVerifiedProvider,
  buildPatch,
  errorPath,
  hasAuthErrors,
  isEmptyPatch,
  isLocked,
  lockedHint,
  P,
  providerFields,
  providerVerified,
  toAuthForm,
  validateAuthForm,
  verifyKey,
  type AuthErrors,
  type AuthForm,
  type FieldPath,
  type ProviderForm,
  type TestedKeys,
} from "@/pages/settings/auth/logic";
import { ProviderSection, type TestState } from "@/pages/settings/auth/ProviderSection";
import { Section, SecretInput, SwitchRow } from "@/pages/settings/parts";

const MODES: { value: AuthMode; label: string; description: string }[] = [
  { value: "password", label: "Пароль", description: "Один администратор (admin) с паролем." },
  {
    value: "sso",
    label: "Внешний вход (SSO)",
    description: "Через свой OpenID Connect (Authentik, Keycloak…), Google или GitHub. Пароль можно оставить запасным.",
  },
  { value: "header", label: "Заголовок от прокси", description: "Вход выполняет прокси перед интерфейсом и передаёт имя пользователя в заголовке." },
  { value: "none", label: "Без входа", description: "Любой, кто откроет адрес, управляет Jackett." },
];

const IDLE: TestState = { status: "idle" };

/** Plain string fields of the form, edited through `text()`. */
type TextKey = "allowedEmails" | "githubUsers" | "headerName" | "headerTrusted" | "publicUrl" | "sessionTtl";
const TEXT_PATH: Record<TextKey, FieldPath> = {
  allowedEmails: P.allowedEmails,
  githubUsers: P.githubUsers,
  headerName: P.headerName,
  headerTrusted: P.headerTrusted,
  publicUrl: P.publicUrl,
  sessionTtl: P.sessionTtl,
};

function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="border-t pt-4 text-sm font-semibold">{children}</h3>;
}

export function AuthSettingsCard() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: qk.uiSettings, queryFn: () => serverApi.getSettings(), refetchOnWindowFocus: false });

  const [base, setBase] = useState<UiSettings | null>(null);
  const [form, setForm] = useState<AuthForm | null>(null);
  const [serverErrors, setServerErrors] = useState<AuthErrors>({});
  const [generalError, setGeneralError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmNone, setConfirmNone] = useState(false);
  const [tested, setTested] = useState<TestedKeys>({});
  const [tests, setTests] = useState<Partial<Record<ProviderId, TestState>>>({});
  const polls = useRef<Partial<Record<ProviderId, AbortController>>>({});

  useEffect(() => () => Object.values(polls.current).forEach((c) => c?.abort()), []);

  const patch = useMemo<UiSettingsPatch | null>(() => (form && base ? buildPatch(form, base) : null), [form, base]);
  const dirty = !!patch && !isEmptyPatch(patch);

  useEffect(() => {
    const s = query.data;
    if (!s) return;
    if (!base || !form || isEmptyPatch(buildPatch(form, base))) {
      setBase(s);
      setForm(toAuthForm(s));
    }
    // Only react to new server data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data]);

  const clientErrors = useMemo(() => (form && base ? validateAuthForm(form, base, tested) : {}), [form, base, tested]);
  const errors: AuthErrors = { ...clientErrors, ...serverErrors };
  const invalid = hasAuthErrors(clientErrors);

  if (query.isPending || (!form && !query.isError)) {
    return (
      <Section id="auth" title="Вход и безопасность" icon={ShieldCheck}>
        <Skeleton className="h-40 w-full" />
      </Section>
    );
  }
  if (!form || !base) {
    return (
      <Section id="auth" title="Вход и безопасность" icon={ShieldCheck}>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} className="py-6" />
      </Section>
    );
  }

  const s = base;
  const clearServerError = (path: FieldPath) => {
    if (serverErrors[path]) setServerErrors(({ [path]: _drop, ...rest }) => rest);
  };
  const set = <K extends keyof AuthForm>(k: K, v: AuthForm[K], path?: FieldPath) => {
    setForm((f) => (f ? { ...f, [k]: v } : f));
    if (path) clearServerError(path);
  };
  const setProvider = (id: ProviderId, p: Partial<ProviderForm>) => {
    setForm((f) => (f ? { ...f, providers: { ...f.providers, [id]: { ...f.providers[id], ...p } } } : f));
    Object.keys(p).forEach((k) => clearServerError(P.provider(id, k === "clearSecret" ? "clientSecret" : (k as "clientId"))));
  };
  const locked = (path: FieldPath) => isLocked(s, path);
  const hint = (path: FieldPath, normal?: ReactNode) => lockedHint(s, path) ?? normal;
  const text = (k: TextKey, extra: React.ComponentProps<typeof Input> = {}) => ({
    id: `auth-${k}`,
    value: form[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value, TEXT_PATH[k]),
    disabled: locked(TEXT_PATH[k]),
    "aria-invalid": errors[TEXT_PATH[k]] ? true : undefined,
    spellCheck: false,
    autoComplete: "off",
    ...extra,
  });

  const setTest = (id: ProviderId, t: TestState) => setTests((m) => ({ ...m, [id]: t }));

  const startTest = async (id: ProviderId) => {
    polls.current[id]?.abort();
    const key = verifyKey(form, id);
    // Open the tab synchronously (inside the click) so popup blockers let it through.
    const win = window.open("about:blank", "_blank");
    setTest(id, { status: "starting" });
    try {
      const { url } = await serverApi.testProvider(id, providerFields(form, id));
      if (win && !win.closed) {
        win.opener = null;
        win.location.href = url;
      }
      setTest(id, { status: "waiting", url, popupBlocked: !win });
      const token = providerTestToken(url);
      const ac = new AbortController();
      polls.current[id] = ac;
      let failMessage: string | undefined;
      const outcome = token ? await waitForProviderTest(id, token, { signal: ac.signal, onFailed: (m) => (failMessage = m) }) : "timeout";
      if (outcome === "cancelled") return;
      if (outcome === "verified") {
        setTested((t) => ({ ...t, [id]: key }));
        setTest(id, IDLE);
        toast.success("Вход через провайдера проверен");
        void qc.invalidateQueries({ queryKey: qk.uiSettings });
      } else if (outcome === "failed") {
        setTest(id, { status: "failed", message: failMessage || "Провайдер не подтвердил вход" });
      } else {
        setTest(id, { status: "timeout" });
      }
    } catch (e) {
      win?.close();
      setTest(id, { status: "failed", message: errText(e) });
    }
  };

  const cancelTest = (id: ProviderId) => {
    polls.current[id]?.abort();
    setTest(id, IDLE);
  };

  const doSave = async () => {
    if (!patch || isEmptyPatch(patch)) return;
    setSaving(true);
    setServerErrors({});
    setGeneralError("");
    try {
      await serverApi.putSettings(patch);
      const fresh = await qc.fetchQuery({ queryKey: qk.uiSettings, queryFn: () => serverApi.getSettings(), staleTime: 0 });
      setBase(fresh);
      setForm(toAuthForm(fresh));
      setConfirmNone(false);
      toast.success(patch.auth?.mode ? "Сохранено, способ входа изменён" : "Сохранено");
      // A mode or password change re-issues our session cookie; the header shows the mode.
      void qc.invalidateQueries({ queryKey: qk.authState });
    } catch (e) {
      setConfirmNone(false);
      const path = e instanceof ApiError ? errorPath(e.field) : undefined;
      if (path) setServerErrors({ [path]: errText(e) });
      else setGeneralError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    if (!dirty || invalid || saving) return;
    if (patch?.auth?.mode === "none") setConfirmNone(true);
    else void doSave();
  };

  const modeLocked = locked(P.mode);
  const ssoReady = anyVerifiedProvider(form, s, tested);
  const passwordSet = s.auth.passwordSet.value;

  return (
    <Section
      id="auth"
      title="Вход и безопасность"
      icon={ShieldCheck}
      description="Как входить в этот интерфейс. Поиск по API-ключу (qBittorrent, Sonarr, Torznab) работает без входа."
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {/* Mode */}
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Способ входа</legend>
          <RadioGroup value={form.mode} onValueChange={(v) => set("mode", v as AuthMode, P.mode)} disabled={modeLocked} aria-label="Способ входа">
            {MODES.map((m) => {
              const ssoBlocked = m.value === "sso" && !ssoReady && form.mode !== "sso";
              return (
                <div key={m.value} className="flex items-start gap-2.5">
                  <RadioGroupItem value={m.value} id={`auth-mode-${m.value}`} className="mt-0.5" disabled={modeLocked || ssoBlocked} />
                  <Label htmlFor={`auth-mode-${m.value}`} className="min-w-0 cursor-pointer space-y-0.5 font-normal">
                    <span className="font-medium">{m.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {m.description}
                      {ssoBlocked &&
                        !modeLocked &&
                        " Сначала настройте провайдера ниже и нажмите «Проверить вход»: так вы не потеряете доступ."}
                    </span>
                  </Label>
                </div>
              );
            })}
          </RadioGroup>
          {(errors[P.mode] || lockedHint(s, P.mode)) && (
            <p className={errors[P.mode] ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{errors[P.mode] ?? lockedHint(s, P.mode)}</p>
          )}
          {form.mode === "none" && (
            <Callout variant="error" title="Вход будет отключён">
              Любой, кто откроет адрес, сможет управлять Jackett: добавлять трекеры, видеть их пароли и API-ключ. Включайте, только если
              интерфейс доступен лишь в доверенной сети.
            </Callout>
          )}
        </fieldset>

        {/* Password */}
        <SubHeading>{passwordSet ? "Смена пароля" : "Пароль администратора"}</SubHeading>
        {locked(P.password) ? (
          <p className="text-xs text-muted-foreground">Пароль {lockedHint(s, P.password)}.</p>
        ) : (
          <>
            <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
            <div className="grid gap-4 sm:grid-cols-3">
              {passwordSet && (
                <Field label="Текущий пароль" htmlFor="auth-pwCurrent" error={errors[P.passwordCurrent]}>
                  <SecretInput
                    id="auth-pwCurrent"
                    value={form.pwCurrent}
                    onChange={(v) => set("pwCurrent", v, P.passwordCurrent)}
                    autoComplete="current-password"
                    invalid={!!errors[P.passwordCurrent]}
                  />
                </Field>
              )}
              <Field label="Новый пароль" htmlFor="auth-pwNew" error={errors[P.password]} hint={`Не короче ${MIN_PASSWORD} символов`}>
                <SecretInput
                  id="auth-pwNew"
                  value={form.pwNew}
                  onChange={(v) => set("pwNew", v, P.password)}
                  autoComplete="new-password"
                  invalid={!!errors[P.password]}
                />
              </Field>
              <Field label="Ещё раз" htmlFor="auth-pwRepeat" error={errors[P.passwordRepeat]}>
                <SecretInput
                  id="auth-pwRepeat"
                  value={form.pwRepeat}
                  onChange={(v) => set("pwRepeat", v)}
                  autoComplete="new-password"
                  invalid={!!errors[P.passwordRepeat]}
                />
              </Field>
            </div>
            {passwordSet && <p className="text-xs text-muted-foreground">После смены пароля остальные сеансы завершатся.</p>}
          </>
        )}

        {/* External providers */}
          <>
            <SubHeading>Внешний вход (SSO)</SubHeading>
            <p className="text-xs text-muted-foreground">
              Провайдер включается, когда задан его Client ID. На странице входа появится кнопка для каждого проверенного провайдера.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Разрешённые e-mail"
                htmlFor="auth-allowedEmails"
                error={errors[P.allowedEmails]}
                hint={hint(P.allowedEmails, "Через запятую. Для любого провайдера, только подтверждённые адреса")}
              >
                <Input {...text("allowedEmails", { placeholder: "me@example.com" })} />
              </Field>
              <Field
                label="Пользователи GitHub"
                htmlFor="auth-githubUsers"
                error={errors[P.githubUsers]}
                hint={hint(P.githubUsers, "Логины через запятую, регистр не важен")}
              >
                <Input {...text("githubUsers", { placeholder: "octocat" })} />
              </Field>
            </div>
            {allowListsEmpty(form) && (
              <Callout variant="warning" title="Внешний вход сейчас запрещён всем">
                Пока списки e-mail, пользователей GitHub и групп OIDC пусты, сервер не пустит никого через внешних провайдеров — иначе войти
                мог бы любой владелец аккаунта Google или GitHub. Добавьте себя хотя бы в один список.
              </Callout>
            )}

            {PROVIDER_IDS.map((id) => (
              <ProviderSection
                key={id}
                id={id}
                form={form.providers[id]}
                settings={s}
                errors={errors}
                verified={providerVerified(form, s, id, tested)}
                test={tests[id] ?? IDLE}
                onChange={(p) => setProvider(id, p)}
                onTest={() => void startTest(id)}
                onCancelTest={() => cancelTest(id)}
              />
            ))}

            <SwitchRow
              id="auth-passwordFallback"
              label="Оставить вход по паролю"
              description={hint(
                P.passwordFallback,
                passwordSet ? "Рядом с кнопками провайдеров — на случай, если они недоступны." : "Сначала задайте пароль выше.",
              )}
              checked={form.passwordFallback}
              onChange={(v) => set("passwordFallback", v, P.passwordFallback)}
              disabled={locked(P.passwordFallback)}
            />
          </>

        {/* Header mode */}
        {(form.mode === "header" || s.auth.mode.value === "header") && (
          <>
            <SubHeading>Заголовок от прокси</SubHeading>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Имя заголовка" htmlFor="auth-headerName" error={errors[P.headerName]} hint={hint(P.headerName, "Например Remote-User или X-Forwarded-User")}>
                <Input {...text("headerName", { placeholder: "Remote-User" })} />
              </Field>
              <Field
                label="Доверенные сети прокси"
                htmlFor="auth-headerTrusted"
                error={errors[P.headerTrusted]}
                hint={hint(P.headerTrusted, "CIDR через запятую. Заголовок от других адресов игнорируется")}
              >
                <Input {...text("headerTrusted", { placeholder: "172.16.0.0/12" })} />
              </Field>
            </div>
          </>
        )}

        {/* General */}
        <SubHeading>Общее</SubHeading>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Внешний адрес"
            htmlFor="auth-publicUrl"
            error={errors[P.publicUrl]}
            hint={hint(P.publicUrl, "Нужен для адресов возврата SSO и Secure-cookie. Пусто — определяется по запросу")}
          >
            <Input {...text("publicUrl", { type: "url", placeholder: "https://jackett.example.com" })} />
          </Field>
          <Field label="Время жизни сеанса" htmlFor="auth-sessionTtl" error={errors[P.sessionTtl]} hint={hint(P.sessionTtl, "Например 168h (неделя)")}>
            <Input {...text("sessionTtl", { placeholder: "168h" })} />
          </Field>
        </div>

        {generalError && (
          <Callout variant="error" title="Не удалось сохранить">
            {generalError}
          </Callout>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
          {dirty && invalid && <span className="mr-auto text-sm text-destructive">Исправьте ошибки в форме</span>}
          <Button
            type="button"
            variant="outline"
            disabled={!dirty || saving}
            onClick={() => {
              setForm(toAuthForm(s));
              setServerErrors({});
              setGeneralError("");
            }}
          >
            <RotateCcw /> Сбросить
          </Button>
          <Button type="submit" disabled={!dirty || invalid || saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />} Сохранить
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={confirmNone}
        onOpenChange={setConfirmNone}
        title="Отключить вход?"
        description="Любой, кто откроет адрес интерфейса, сможет управлять Jackett без пароля. Делайте это, только если интерфейс доступен лишь в доверенной сети или уже закрыт другим способом."
        confirmLabel="Отключить вход"
        destructive
        pending={saving}
        onConfirm={() => void doSave()}
      />
    </Section>
  );
}
