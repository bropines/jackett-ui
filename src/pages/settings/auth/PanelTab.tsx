import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, RotateCcw, Save, ShieldAlert, ShieldCheck, UserPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import {
  ApiError,
  errText,
  METHOD_IDS,
  PROVIDER_IDS,
  providerTestToken,
  qk,
  ROLES,
  serverApi,
  waitForProviderTest,
  type MethodId,
  type ProviderId,
  type Role,
  type UiSettings,
  type UiSettingsPatch,
} from "@/api";
import { Callout, ConfirmDialog, ErrorState, Field } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox, Skeleton } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ROLE_LABELS } from "@/lib/auth";
import {
  allowListsEmpty,
  buildPatch,
  errorPath,
  hasAuthErrors,
  isEmptyPatch,
  isLocked,
  lockedHint,
  P,
  providerConfigured,
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
import { Section, SwitchRow } from "@/pages/settings/parts";

const METHOD_TEXT: Record<MethodId, { label: string; description: string }> = {
  password: { label: "Пароль", description: "Имя пользователя и пароль." },
  oidc: { label: "OpenID Connect", description: "Свой провайдер: Authentik, Keycloak, Authelia…" },
  google: { label: "Google", description: "Аккаунт Google." },
  github: { label: "GitHub", description: "Аккаунт GitHub." },
  header: { label: "Заголовок от прокси", description: "Вход выполняет прокси перед интерфейсом и передаёт имя пользователя в заголовке." },
};

const IDLE: TestState = { status: "idle" };

/** Plain string fields of the form, edited through `text()`. */
type TextKey = "allowedEmails" | "adminEmails" | "githubUsers" | "headerName" | "headerTrusted" | "publicUrl" | "sessionTtl";
const TEXT_PATH: Record<TextKey, FieldPath> = {
  allowedEmails: P.allowedEmails,
  adminEmails: P.adminEmails,
  githubUsers: P.githubUsers,
  headerName: P.headerName,
  headerTrusted: P.headerTrusted,
  publicUrl: P.publicUrl,
  sessionTtl: P.sessionTtl,
};

const isProvider = (m: MethodId): m is ProviderId => (PROVIDER_IDS as readonly string[]).includes(m);

/** «Панель» tab: login methods, providers, auto-provisioning, allow-lists, public URL, session TTL. */
export function PanelTab() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: qk.uiSettings, queryFn: () => serverApi.getSettings(), refetchOnWindowFocus: false });

  const [base, setBase] = useState<UiSettings | null>(null);
  const [form, setForm] = useState<AuthForm | null>(null);
  const [serverErrors, setServerErrors] = useState<AuthErrors>({});
  const [generalError, setGeneralError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
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
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (!form || !base) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const s = base;
  const clearServerError = (path: FieldPath) => {
    if (serverErrors[path]) setServerErrors(({ [path]: _drop, ...rest }) => rest);
  };
  const set = <K extends keyof AuthForm>(k: K, v: AuthForm[K], path?: FieldPath) => {
    setForm((f) => (f ? { ...f, [k]: v } : f));
    if (path) clearServerError(path);
  };
  const setMethod = (m: MethodId, on: boolean) => {
    setForm((f) => (f ? { ...f, methods: { ...f.methods, [m]: on } } : f));
    clearServerError(P.methods);
    clearServerError(P.method(m));
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
      setConfirmDisable(false);
      toast.success(patch.auth?.methods || patch.auth?.disabled !== undefined ? "Сохранено, способы входа изменены" : "Сохранено");
      // Methods / disabled change what auth/state reports (banner, login page).
      void qc.invalidateQueries({ queryKey: qk.authState });
    } catch (e) {
      setConfirmDisable(false);
      const path = e instanceof ApiError ? errorPath(e.field) : undefined;
      if (path) setServerErrors({ [path]: errText(e) });
      else setGeneralError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    if (!dirty || invalid || saving) return;
    if (patch?.auth?.disabled === true) setConfirmDisable(true);
    else void doSave();
  };

  const methodsLocked = locked(P.methods);
  const methodsError = errors[P.methods];
  const anyProviderOn = PROVIDER_IDS.some((id) => form.methods[id]);

  return (
    <form
      className="mx-auto max-w-3xl space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Section id="auth-methods" title="Способы входа" icon={ShieldCheck} description="Как пользователи входят в этот интерфейс. Можно включить несколько.">
        <fieldset className="space-y-3" disabled={form.disabled}>
          <legend className="sr-only">Способы входа</legend>
          {METHOD_IDS.map((m) => {
            const verified = isProvider(m) ? providerVerified(form, s, m, tested) : true;
            const blocked = isProvider(m) && !form.methods[m] && !verified;
            const err = errors[P.method(m)];
            const t = METHOD_TEXT[m];
            return (
              <div key={m} className="flex items-start gap-2.5">
                <Checkbox
                  id={`auth-method-${m}`}
                  checked={form.methods[m]}
                  onCheckedChange={(v) => setMethod(m, v === true)}
                  disabled={methodsLocked || blocked || form.disabled}
                  className="mt-0.5"
                  aria-invalid={err ? true : undefined}
                />
                <Label htmlFor={`auth-method-${m}`} className="min-w-0 cursor-pointer space-y-0.5 font-normal">
                  <span className="font-medium">{t.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t.description}
                    {blocked && !methodsLocked && " Сначала настройте провайдера ниже и нажмите «Проверить вход»: так вы не потеряете доступ."}
                  </span>
                  {err && <span className="block text-xs text-destructive">{err}</span>}
                </Label>
              </div>
            );
          })}
        </fieldset>
        {(methodsError || lockedHint(s, P.methods)) && (
          <p className={methodsError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{methodsError ?? lockedHint(s, P.methods)}</p>
        )}

        <div className="space-y-3 rounded-lg border border-destructive/40 p-3">
          <SwitchRow
            id="auth-disabled"
            label={
              <span className="inline-flex items-center gap-1.5 text-destructive">
                <ShieldAlert className="h-4 w-4" aria-hidden /> Отключить вход полностью
              </span>
            }
            description={hint(P.disabled, "Любой, кто откроет адрес, станет администратором. Только для доверенной сети.")}
            checked={form.disabled}
            onChange={(v) => set("disabled", v, P.disabled)}
            disabled={locked(P.disabled)}
          />
          {form.disabled && !s.auth.disabled?.value && (
            <Callout variant="error" title="Вход будет отключён">
              Любой, кто откроет адрес, сможет управлять Jackett и пользователями: добавлять трекеры, видеть их пароли. Включайте, только если
              интерфейс доступен лишь в доверенной сети.
            </Callout>
          )}
        </div>
      </Section>

      <Section
        id="auth-provision"
        title="Новые пользователи"
        icon={UserPlus}
        description="Кого пускать через внешних провайдеров без приглашения. Приглашённым эти списки не нужны."
      >
        <SwitchRow
          id="auth-autoProvision"
          label="Создавать пользователя при первом входе"
          description={hint(P.autoProvision, "Если аккаунт проходит списки ниже. Иначе — только по приглашению или привязке.")}
          checked={form.autoProvision}
          onChange={(v) => set("autoProvision", v, P.autoProvision)}
          disabled={locked(P.autoProvision)}
        />
        <Field label="Роль новых пользователей" htmlFor="auth-defaultRole" hint={hint(P.defaultRole)}>
          <Select value={form.defaultRole} onValueChange={(v) => set("defaultRole", v as Role, P.defaultRole)} disabled={locked(P.defaultRole) || !form.autoProvision}>
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
            error={errors[P.allowedEmails]}
            hint={hint(P.allowedEmails, "Через запятую. Любой провайдер, только подтверждённые адреса")}
          >
            <Input {...text("allowedEmails", { placeholder: "me@example.com" })} />
          </Field>
          <Field
            label="E-mail администраторов"
            htmlFor="auth-adminEmails"
            error={errors[P.adminEmails]}
            hint={hint(P.adminEmails, "Новые пользователи с этими адресами получат роль «Админ»")}
          >
            <Input {...text("adminEmails", { placeholder: "admin@example.com" })} />
          </Field>
          <Field label="Пользователи GitHub" htmlFor="auth-githubUsers" error={errors[P.githubUsers]} hint={hint(P.githubUsers, "Логины через запятую, регистр не важен")}>
            <Input {...text("githubUsers", { placeholder: "octocat" })} />
          </Field>
        </div>
        {form.autoProvision && anyProviderOn && allowListsEmpty(form) && (
          <Callout variant="warning" title="Без приглашения сейчас не войдёт никто">
            Пока списки e-mail, пользователей GitHub и групп OIDC пусты, сервер не создаёт пользователей сам — иначе войти мог бы любой владелец
            аккаунта Google или GitHub. Добавьте адреса или приглашайте людей на вкладке «Пользователи».
          </Callout>
        )}
      </Section>

      <Section id="auth-providers" title="Провайдеры" icon={KeyRound} description="Провайдер работает, когда задан его Client ID, вход проверен и способ включён выше.">
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
        {!providerConfigured(form, "oidc") && !providerConfigured(form, "google") && !providerConfigured(form, "github") && (
          <p className="text-xs text-muted-foreground">Ни один провайдер пока не настроен.</p>
        )}
      </Section>

      {(form.methods.header || s.auth.methods?.header?.value) && (
        <Section id="auth-header" title="Заголовок от прокси" icon={ShieldCheck}>
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
          <p className="text-xs text-muted-foreground">Значение заголовка — имя пользователя в этой панели.</p>
        </Section>
      )}

      <Section id="auth-general" title="Общее" icon={ShieldCheck}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Внешний адрес"
            htmlFor="auth-publicUrl"
            error={errors[P.publicUrl]}
            hint={hint(P.publicUrl, "Для адресов возврата, приглашений и Secure-cookie. Пусто — по запросу")}
          >
            <Input {...text("publicUrl", { type: "url", placeholder: "https://jackett.example.com" })} />
          </Field>
          <Field label="Время жизни сеанса" htmlFor="auth-sessionTtl" error={errors[P.sessionTtl]} hint={hint(P.sessionTtl, "Например 168h (неделя)")}>
            <Input {...text("sessionTtl", { placeholder: "168h" })} />
          </Field>
        </div>
      </Section>

      {generalError && (
        <Callout variant="error" title="Не удалось сохранить">
          {generalError}
        </Callout>
      )}

      <div className="sticky bottom-0 z-20 -mx-3 flex flex-wrap items-center justify-end gap-2 border-t bg-background/95 px-3 py-3 backdrop-blur md:mx-0 md:rounded-t-lg md:border md:border-b-0 md:px-4">
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

      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title="Отключить вход?"
        description="Любой, кто откроет адрес интерфейса, станет администратором без пароля. Делайте это, только если интерфейс доступен лишь в доверенной сети или уже закрыт другим способом."
        confirmLabel="Отключить вход"
        destructive
        pending={saving}
        onConfirm={() => void doSave()}
      />
    </form>
  );
}
