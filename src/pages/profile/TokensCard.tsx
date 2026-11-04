import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { errText, qk, serverApi, type ApiToken, type CreatedToken } from "@/api";
import { Callout, ConfirmDialog, CopyButton, CopyField, EmptyState, Field, Mono, RelativeTime } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/misc";
import { qbitPluginJson, torznabTemplate, torznabUrlWithKey } from "@/lib/clients";
import { formatDateTime } from "@/lib/format";
import { isExpired, TOKEN_EXPIRY, TOKEN_NAME_MAX, tokenCreateBody, tokenNameError } from "@/pages/profile/logic";
import { Section } from "@/pages/settings/parts";

function CreateTokenDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (t: CreatedToken) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [days, setDays] = useState(0);
  const [touched, setTouched] = useState(false);
  const create = useMutation({
    mutationFn: () => serverApi.createMyToken(tokenCreateBody(name, days)),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: qk.me });
      close(false);
      onCreated(t);
    },
  });
  const err = tokenNameError(name);

  function close(o: boolean) {
    onOpenChange(o);
    if (!o) {
      setName("");
      setDays(0);
      setTouched(false);
      create.reset();
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (err || create.isPending) return;
    create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Новый API-токен</DialogTitle>
          <DialogDescription>Токен действует от вашего имени и с вашей ролью, только для поиска и Torznab.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Название" htmlFor="token-name" error={touched ? err : undefined} hint="Чтобы потом понять, где он используется">
            <Input
              id="token-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="qBittorrent"
              maxLength={TOKEN_NAME_MAX}
              autoComplete="off"
              aria-invalid={touched && err ? true : undefined}
            />
          </Field>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Срок действия</legend>
            <RadioGroup value={String(days)} onValueChange={(v) => setDays(Number(v))} className="flex flex-wrap gap-x-4 gap-y-2" aria-label="Срок действия">
              {TOKEN_EXPIRY.map((o) => (
                <div key={o.days} className="flex items-center gap-2">
                  <RadioGroupItem value={String(o.days)} id={`token-exp-${o.days}`} />
                  <Label htmlFor={`token-exp-${o.days}`} className="cursor-pointer font-normal">
                    {o.label}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </fieldset>
          {create.isError && <Callout variant="error">{errText(create.error)}</Callout>}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Loader2 className="animate-spin" />} Создать
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Shows a freshly created token once, with ready-to-paste settings for clients. */
export function CreatedTokenDialog({ token, onClose }: { token: CreatedToken | null; onClose: () => void }) {
  const origin = window.location.origin;
  const secret = token?.token ?? "";
  return (
    <Dialog open={!!token} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Токен «{token?.name}» создан</DialogTitle>
          <DialogDescription>Скопируйте его сейчас: больше он не покажется. Потерянный токен отзовите и создайте новый.</DialogDescription>
        </DialogHeader>
        <Field label="Токен">
          <CopyField value={secret} label="Копировать токен" />
        </Field>

        <section className="space-y-2" aria-labelledby="tok-qbit">
          <h3 id="tok-qbit" className="text-sm font-semibold">
            qBittorrent (плагин поиска «Jackett»)
          </h3>
          <p className="text-xs text-muted-foreground">В настройках плагина укажите адрес Jackett и API-ключ = этот токен.</p>
          <Field label="Адрес Jackett">
            <CopyField value={origin} label="Копировать адрес Jackett" />
          </Field>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              Или замените файл <code className="rounded bg-muted px-1">nova3/engines/jackett.json</code>:
            </span>
            <CopyButton value={() => qbitPluginJson(origin, secret)} label="Копировать jackett.json" withText />
          </div>
        </section>

        <section className="space-y-2" aria-labelledby="tok-torznab">
          <h3 id="tok-torznab" className="text-sm font-semibold">
            Sonarr, Radarr, Prowlarr (Torznab)
          </h3>
          <p className="text-xs text-muted-foreground">
            Адрес индексатора: вместо <Mono>{"{id}"}</Mono> — id трекера (меню трекера → «Копировать Torznab-адрес») или <Mono>all</Mono> для
            всех. API key — этот токен.
          </p>
          <Field label="Шаблон адреса">
            <CopyField value={torznabTemplate(origin)} label="Копировать шаблон Torznab" />
          </Field>
          <Field label="Все трекеры, с ключом в адресе">
            <CopyField value={torznabUrlWithKey("all", secret, origin)} label="Копировать Torznab-адрес с токеном" />
          </Field>
        </section>

        <DialogFooter>
          <Button onClick={onClose}>Готово, я сохранил токен</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TokenRow({ t, onRevoke }: { t: ApiToken; onRevoke: () => void }) {
  const expired = isExpired(t);
  return (
    <li className="flex items-start gap-3 px-4 py-3 text-sm">
      <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{t.name}</span>
          <Mono className="text-xs text-muted-foreground">{t.prefix}…</Mono>
          {expired && <Badge variant="destructive">истёк</Badge>}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span>
            создан <RelativeTime iso={t.createdAt} />
          </span>
          <span>
            использован <RelativeTime iso={t.lastUsedAt} never="никогда" />
            {t.lastUsedIp && <> с {t.lastUsedIp}</>}
          </span>
          <span>{t.expiresAt ? `${expired ? "истёк" : "действует до"} ${formatDateTime(t.expiresAt)}` : "бессрочный"}</span>
        </div>
      </div>
      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={`Отозвать токен ${t.name}`} onClick={onRevoke}>
        <Trash2 />
      </Button>
    </li>
  );
}

export function TokensCard({ tokens }: { tokens: ApiToken[] }) {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [toRevoke, setToRevoke] = useState<ApiToken | null>(null);
  const revoke = useMutation({
    mutationFn: (t: ApiToken) => serverApi.deleteMyToken(t.id),
    onSuccess: (_r, t) => {
      setToRevoke(null);
      toast.success(`Токен «${t.name}» отозван`);
      void qc.invalidateQueries({ queryKey: qk.me });
    },
    onError: (e) => {
      setToRevoke(null);
      toast.error(errText(e));
    },
  });

  return (
    <Section
      id="tokens"
      title="API-токены"
      icon={KeyRound}
      description="Для qBittorrent, Sonarr, Radarr и других клиентов Torznab. Ключ самого Jackett им не нужен."
    >
      <div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus /> Создать токен
        </Button>
      </div>
      {tokens.length === 0 ? (
        <EmptyState icon={KeyRound} title="Токенов пока нет" description="Создайте токен и вставьте его в клиент вместо API-ключа." className="py-6" />
      ) : (
        <ul className="divide-y rounded-md border" aria-label="Мои API-токены">
          {tokens.map((t) => (
            <TokenRow key={t.id} t={t} onRevoke={() => setToRevoke(t)} />
          ))}
        </ul>
      )}

      <CreateTokenDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={setCreated} />
      <CreatedTokenDialog token={created} onClose={() => setCreated(null)} />
      <ConfirmDialog
        open={toRevoke !== null}
        onOpenChange={(o) => !o && !revoke.isPending && setToRevoke(null)}
        title={`Отозвать токен «${toRevoke?.name ?? ""}»?`}
        description="Клиенты с этим токеном сразу перестанут находить и скачивать."
        confirmLabel="Отозвать"
        destructive
        pending={revoke.isPending}
        onConfirm={() => toRevoke && revoke.mutate(toRevoke)}
      />
    </Section>
  );
}
