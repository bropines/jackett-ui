import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Fingerprint, Loader2, Pencil, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { errText, qk, serverApi, type Passkey } from "@/api";
import { AddPasskeyDialog, PasskeyUnavailable } from "@/components/auth/passkey";
import { PASSKEY_NAME_MAX, usePasskeyAvailability } from "@/lib/passkey";
import { Callout, ConfirmDialog, ErrorState, Field, RelativeTime } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Section } from "@/pages/settings/parts";

function RenameDialog({ passkey, onOpenChange }: { passkey: Passkey | null; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [forId, setForId] = useState<string | undefined>();
  if (passkey && passkey.id !== forId) {
    setForId(passkey.id);
    setName(passkey.name);
  }
  const rename = useMutation({
    mutationFn: () => serverApi.renameMyPasskey(passkey!.id, name.trim()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.myPasskeys });
      close(false);
    },
  });
  function close(o: boolean) {
    onOpenChange(o);
    if (!o) {
      setForId(undefined);
      rename.reset();
    }
  }
  const empty = !name.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!empty && !rename.isPending) rename.mutate();
  };
  return (
    <Dialog open={!!passkey} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Переименовать passkey</DialogTitle>
          <DialogDescription>Название видно только вам.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Название" htmlFor="passkey-rename" error={rename.isError ? errText(rename.error) : undefined}>
            <Input id="passkey-rename" value={name} onChange={(e) => setName(e.target.value)} maxLength={PASSKEY_NAME_MAX} autoComplete="off" />
          </Field>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={empty || rename.isPending}>
              {rename.isPending && <Loader2 className="animate-spin" />} Сохранить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Profile: own passkeys (list, rename, delete, add). */
export function PasskeysCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.myPasskeys, queryFn: () => serverApi.myPasskeys() });
  const availability = usePasskeyAvailability();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<Passkey | null>(null);
  const [toDelete, setToDelete] = useState<Passkey | null>(null);
  const remove = useMutation({
    mutationFn: (p: Passkey) => serverApi.deleteMyPasskey(p.id),
    onSuccess: () => {
      setToDelete(null);
      toast.success("Passkey удалён");
      void qc.invalidateQueries({ queryKey: qk.myPasskeys });
      void qc.invalidateQueries({ queryKey: qk.authState });
    },
    onError: () => setToDelete(null),
  });

  let list: React.ReactNode;
  if (q.isPending) list = <Skeleton className="h-16 w-full" />;
  else if (q.isError) list = <ErrorState error={q.error} onRetry={() => void q.refetch()} className="py-6" />;
  else if (q.data.length === 0) list = <p className="text-sm text-muted-foreground">Passkey пока нет.</p>;
  else
    list = (
      <ul className="divide-y rounded-md border" aria-label="Мои passkey">
        {q.data.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <Fingerprint className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">{p.name}</span>
                {p.synced && <Badge variant="secondary">синхронизирован</Badge>}
              </div>
              <div className="text-xs text-muted-foreground">
                создан <RelativeTime iso={p.createdAt} /> · последний вход <RelativeTime iso={p.lastUsedAt} never="никогда" />
              </div>
              {p.cloneWarning && (
                <p className="mt-1 flex items-start gap-1 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                  Похоже, этот passkey скопирован: вход с ним запрещён. Удалите его и добавьте новый.
                </p>
              )}
            </div>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" aria-label={`Переименовать ${p.name}`} onClick={() => setRenaming(p)}>
                <Pencil />
              </Button>
              <Button variant="ghost" size="icon" aria-label={`Удалить ${p.name}`} onClick={() => setToDelete(p)}>
                <Trash2 />
              </Button>
            </div>
          </li>
        ))}
      </ul>
    );

  return (
    <Section id="passkeys" title="Passkeys" icon={Fingerprint} description="Вход без пароля: отпечаток, Face ID, PIN или ключ безопасности.">
      <PasskeyUnavailable availability={availability} />
      {availability.methodOn === false && <p className="text-xs text-muted-foreground">Вход по passkey сейчас выключен в настройках панели.</p>}
      {remove.isError && <Callout variant="error">{errText(remove.error)}</Callout>}
      {list}
      <div>
        <Button variant="outline" onClick={() => setAdding(true)} disabled={!availability.browser}>
          <Fingerprint /> Добавить passkey
        </Button>
      </div>
      <AddPasskeyDialog open={adding} onOpenChange={setAdding} />
      <RenameDialog passkey={renaming} onOpenChange={(o) => !o && setRenaming(null)} />
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && !remove.isPending && setToDelete(null)}
        title={`Удалить ${toDelete?.name ?? "passkey"}?`}
        description="Входить с ним больше не получится. Удалите его и на устройстве, если он там больше не нужен."
        confirmLabel="Удалить"
        destructive
        pending={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete)}
      />
    </Section>
  );
}
