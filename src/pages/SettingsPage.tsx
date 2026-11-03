import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, Download, Eye, EyeOff, HardDrive, KeyRound, Loader2, Network, RotateCcw, Save, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { api, errText, qk, type ProxyType, type ServerConfig } from "@/api";
import { Callout, CopyButton, CopyField, ErrorState, Field, KeyValue, Mono, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { AdminPasswordCard } from "@/pages/settings/AdminPasswordCard";
import {
  fromForm,
  hasErrors,
  humanSeconds,
  isDirty,
  maskSecret,
  PROXY_TYPES,
  proxyChanged,
  type SettingsForm,
  toForm,
  validate,
} from "@/pages/settings/logic";
import { Section, SecretInput, SwitchRow } from "@/pages/settings/parts";
import { pollUntilUp } from "@/pages/settings/restart";

function ApiKeyCard({ cfg }: { cfg: ServerConfig }) {
  const [shown, setShown] = useState(false);
  const origin = window.location.origin;
  return (
    <Section
      id="api-key"
      title="API-ключ"
      icon={KeyRound}
      description="Нужен поисковому плагину qBittorrent, Sonarr/Radarr и Torznab-ссылкам."
    >
      {cfg.notices.length > 0 && (
        <Callout variant="warning" title="Сообщения Jackett">
          <ul className="list-disc space-y-1 pl-4">
            {cfg.notices.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Callout>
      )}
      <Field label="Ключ">
        <div className="flex items-center gap-1 rounded-md border bg-muted/40 py-1.5 pl-3 pr-1.5">
          <Mono className="min-w-0 flex-1 break-all text-sm">{shown ? cfg.api_key : maskSecret(cfg.api_key)}</Mono>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground"
            onClick={() => setShown(!shown)}
            aria-label={shown ? "Скрыть ключ" : "Показать ключ"}
          >
            {shown ? <EyeOff /> : <Eye />}
          </Button>
          <CopyButton value={cfg.api_key} label="Копировать ключ" />
        </div>
      </Field>
      <Field label="Адрес Jackett для клиентов" hint="Вставьте его в настройки qBittorrent, Sonarr, Radarr и т. п.">
        <CopyField value={origin} label="Копировать адрес" />
      </Field>
    </Section>
  );
}

function SettingsSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-40 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: qk.serverConfig, queryFn: api.serverConfig, refetchOnWindowFocus: false });
  const cfg = query.data;

  // `base` is the config the form was built from; background refetches don't clobber unsaved edits.
  const [base, setBase] = useState<ServerConfig | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  useEffect(() => {
    if (!cfg) return;
    if (!base || !form || !isDirty(form, base)) {
      setBase(cfg);
      setForm(toForm(cfg));
    }
    // Only react to new server data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg]);

  const errors = useMemo(() => (form ? validate(form) : {}), [form]);
  const invalid = hasErrors(errors);
  const dirty = !!form && !!base && isDirty(form, base);

  if (query.isPending || (!form && !query.isError)) {
    return (
      <>
        <PageHeader title="Настройки" />
        <SettingsSkeleton />
      </>
    );
  }
  if (query.isError && !form) {
    return (
      <>
        <PageHeader title="Настройки" />
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      </>
    );
  }
  if (!form || !base) return null;

  const set = <K extends keyof SettingsForm>(k: K, v: SettingsForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const text = (k: keyof SettingsForm) => ({
    id: `cfg-${k}`,
    value: form[k] as string,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value as never),
    "aria-invalid": errors[k] ? true : undefined,
    spellCheck: false,
  });

  const proxyOff = form.proxy_type === -1;
  const ttl = Number(form.cache_ttl);

  const save = async () => {
    if (!dirty || invalid) return;
    const next = fromForm(form, base);
    const restart = proxyChanged(base, next);
    setSaving(true);
    try {
      await api.saveServerConfig(next);
      let fresh: ServerConfig;
      if (restart) {
        setRestarting(true);
        const up = await pollUntilUp(() => api.serverConfig(), { isCancelled: () => unmounted.current });
        if (unmounted.current) return;
        setRestarting(false);
        if (!up) {
          toast.error("Настройки сохранены, но Jackett пока не отвечает. Обновите страницу чуть позже.");
          return;
        }
        fresh = up;
        qc.setQueryData(qk.serverConfig, fresh);
      } else {
        fresh = await qc.fetchQuery({ queryKey: qk.serverConfig, queryFn: api.serverConfig, staleTime: 0 });
      }
      setBase(fresh);
      setForm(toForm(fresh));
      toast.success(restart ? "Сохранено, Jackett перезапущен" : "Сохранено");
    } catch (e) {
      toast.error(`Не удалось сохранить: ${errText(e)}`);
    } finally {
      if (!unmounted.current) {
        setSaving(false);
        setRestarting(false);
      }
    }
  };

  return (
    <div className="min-w-0">
      <PageHeader
        title="Настройки"
        description={
          <>
            Jackett <Mono>{base.app_version}</Mono>
          </>
        }
      />

      {restarting && (
        <Callout variant="info" className="mb-4" title="Jackett перезапускается…">
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Это занимает несколько секунд.
          </span>
        </Callout>
      )}

      <div className="mx-auto max-w-3xl space-y-4">
      <form
        id="settings-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        noValidate
      >
        <ApiKeyCard cfg={base} />

        <Section id="proxy" title="Прокси" icon={Network} description="Через прокси Jackett ходит на трекеры, заблокированные у провайдера.">
          <div className="grid gap-4 sm:grid-cols-[12rem_1fr_8rem]">
            <Field label="Тип" htmlFor="cfg-proxy_type">
              <Select value={String(form.proxy_type)} onValueChange={(v) => set("proxy_type", Number(v) as ProxyType)}>
                <SelectTrigger id="cfg-proxy_type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROXY_TYPES.map((p) => (
                    <SelectItem key={p.value} value={String(p.value)}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Хост" htmlFor="cfg-proxy_url" error={proxyOff ? undefined : errors.proxy_url}>
              <Input {...text("proxy_url")} disabled={proxyOff} placeholder="127.0.0.1" autoComplete="off" />
            </Field>
            <Field label="Порт" htmlFor="cfg-proxy_port" error={proxyOff ? undefined : errors.proxy_port}>
              <Input {...text("proxy_port")} disabled={proxyOff} inputMode="numeric" placeholder="1080" autoComplete="off" />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Логин" htmlFor="cfg-proxy_username" hint="Если прокси требует авторизацию">
              <Input {...text("proxy_username")} disabled={proxyOff} autoComplete="off" />
            </Field>
            <Field label="Пароль" htmlFor="cfg-proxy_password">
              <SecretInput
                id="cfg-proxy_password"
                value={form.proxy_password}
                onChange={(v) => set("proxy_password", v)}
                disabled={proxyOff}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <Callout variant="warning">После сохранения изменений прокси Jackett перезапустится на несколько секунд.</Callout>
        </Section>

        <Section
          id="flaresolverr"
          title="FlareSolverr"
          icon={Cloud}
          description="Нужен для трекеров, закрытых защитой Cloudflare: решает её проверку вместо браузера."
        >
          <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
            <Field label="Адрес" htmlFor="cfg-flaresolverrurl" error={errors.flaresolverrurl} hint="Пусто — не использовать">
              <Input {...text("flaresolverrurl")} type="url" placeholder="http://flaresolverr:8191" autoComplete="off" />
            </Field>
            <Field label="Таймаут, мс" htmlFor="cfg-flaresolverr_maxtimeout" error={errors.flaresolverr_maxtimeout}>
              <Input {...text("flaresolverr_maxtimeout")} inputMode="numeric" />
            </Field>
          </div>
        </Section>

        <Section id="cache" title="Кэш" icon={HardDrive} description="Jackett запоминает результаты поиска, чтобы не дёргать трекеры повторно.">
          <SwitchRow id="cfg-cache_enabled" label="Кэшировать результаты" checked={form.cache_enabled} onChange={(v) => set("cache_enabled", v)} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Время жизни, с"
              htmlFor="cfg-cache_ttl"
              error={errors.cache_ttl}
              hint={!errors.cache_ttl && Number.isFinite(ttl) ? humanSeconds(ttl) : undefined}
            >
              <Input {...text("cache_ttl")} inputMode="numeric" disabled={!form.cache_enabled} />
            </Field>
            <Field label="Максимум результатов на трекер" htmlFor="cfg-cache_max_results_per_indexer" error={errors.cache_max_results_per_indexer}>
              <Input {...text("cache_max_results_per_indexer")} inputMode="numeric" disabled={!form.cache_enabled} />
            </Field>
          </div>
        </Section>

        <Section id="downloads" title="Загрузки" icon={Download}>
          <Field
            label="Папка blackhole"
            htmlFor="cfg-blackholedir"
            hint="Необязательно. Путь на сервере Jackett: туда можно сохранять .torrent-файлы из результатов поиска, а торрент-клиент их подхватит."
          >
            <Input {...text("blackholedir")} placeholder="/downloads/watch" autoComplete="off" />
          </Field>
        </Section>

        <Section id="advanced" title="Дополнительно" icon={SlidersHorizontal}>
          <KeyValue
            items={[
              ["Версия", <Mono key="v">{base.app_version}</Mono>],
              ["Порт", <Mono key="p">{base.port}</Mono>],
              ["Внешний доступ", base.external ? "включён (слушает все адреса)" : "выключен (только localhost)"],
              ["Адрес привязки", <Mono key="b">{base.local_bind_address || "—"}</Mono>],
            ]}
          />
          <p className="text-xs text-muted-foreground">Порт и внешний доступ задаются при запуске Jackett (например, в Docker).</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Base URL override" htmlFor="cfg-baseurloverride" error={errors.baseurloverride} hint="Внешний адрес для ссылок, если Jackett за прокси">
              <Input {...text("baseurloverride")} type="url" placeholder="https://jackett.example.com" autoComplete="off" />
            </Field>
            <Field label="Base path override" htmlFor="cfg-basepathoverride" error={errors.basepathoverride} hint="Если Jackett открыт по подпути">
              <Input {...text("basepathoverride")} placeholder="/jackett" autoComplete="off" />
            </Field>
            <Field label="Ключ OMDb API" htmlFor="cfg-omdbkey" hint="Для обогащения результатов данными о фильмах">
              <SecretInput id="cfg-omdbkey" value={form.omdbkey} onChange={(v) => set("omdbkey", v)} />
            </Field>
            <Field label="Адрес OMDb" htmlFor="cfg-omdburl" error={errors.omdburl} hint="Пусто — стандартный">
              <Input {...text("omdburl")} type="url" placeholder="https://www.omdbapi.com" autoComplete="off" />
            </Field>
          </div>
          <div className="space-y-4 border-t pt-4">
            <SwitchRow id="cfg-cors" label="CORS" description="Разрешить запросы к API со сторонних сайтов" checked={form.cors} onChange={(v) => set("cors", v)} />
            <SwitchRow id="cfg-logging" label="Писать журнал в файл" description="Подробный лог в папке конфигурации Jackett" checked={form.logging} onChange={(v) => set("logging", v)} />
            <SwitchRow
              id="cfg-updatedisabled"
              label="Отключить автообновление"
              description="Обычно включено в Docker: обновляется образ"
              checked={form.updatedisabled}
              onChange={(v) => set("updatedisabled", v)}
            />
            <SwitchRow
              id="cfg-prerelease"
              label="Обновляться до pre-release"
              checked={form.prerelease}
              onChange={(v) => set("prerelease", v)}
              disabled={form.updatedisabled}
            />
          </div>
        </Section>

      </form>

      <AdminPasswordCard />

        {(dirty || saving) && (
          <div
            className={cn(
              "sticky bottom-0 z-20 -mx-3 flex flex-wrap items-center justify-end gap-2 border-t bg-background/95 px-3 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:mx-0 md:rounded-t-lg md:border md:border-b-0 md:px-4",
            )}
            role="region"
            aria-label="Несохранённые изменения"
          >
            <span className={cn("mr-auto text-sm", invalid ? "text-destructive" : "text-muted-foreground")}>
              {invalid ? "Исправьте ошибки в форме" : restarting ? "Jackett перезапускается…" : "Есть несохранённые изменения"}
            </span>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => {
                setForm(toForm(base));
              }}
            >
              <RotateCcw />
              Сбросить
            </Button>
            <Button type="submit" form="settings-form" disabled={saving || invalid || !dirty}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              Сохранить
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
