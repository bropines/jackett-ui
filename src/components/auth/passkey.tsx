import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fingerprint, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { errText, qk, type Passkey } from "@/api";
import { Callout, Field } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { defaultPasskeyName, PASSKEY_NAME_MAX, registerPasskey, type PasskeyAvailability } from "@/lib/passkey";
import { passkeysSupported, webauthnErrorText } from "@/lib/webauthn";

/** Explains why passkeys can't be used here, or nothing. */
export function PasskeyUnavailable({ availability }: { availability: PasskeyAvailability }) {
  if (!availability.browser) {
    return <Callout variant="warning">Этот браузер не поддерживает passkey.</Callout>;
  }
  if (availability.available === false) {
    return (
      <Callout variant="warning" title="Passkey сейчас недоступен">
        {availability.reason || "Passkey работает только по https-адресу с доменным именем (PUBLIC_URL)."}
      </Callout>
    );
  }
  return null;
}

/** Dialog: name + the browser ceremony. */
export function AddPasskeyDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded?: (p: Passkey) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(defaultPasskeyName);
  const [error, setError] = useState("");
  const add = useMutation({
    mutationFn: () => registerPasskey(name || "Passkey"),
    onMutate: () => setError(""),
    onSuccess: (p) => {
      toast.success("Passkey добавлен");
      void qc.invalidateQueries({ queryKey: qk.myPasskeys });
      void qc.invalidateQueries({ queryKey: qk.authState });
      onAdded?.(p);
      close(false);
    },
    onError: (e) => {
      const browser = webauthnErrorText(e);
      if (browser === null) return; // cancelled
      setError(browser ?? errText(e));
    },
  });

  function close(o: boolean) {
    onOpenChange(o);
    if (!o) {
      setName(defaultPasskeyName());
      setError("");
      add.reset();
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!add.isPending) add.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Новый passkey</DialogTitle>
          <DialogDescription>Браузер попросит подтвердить: отпечаток, лицо, PIN или ключ безопасности.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Название" htmlFor="passkey-name" hint="Чтобы отличать passkey в списке">
            <Input id="passkey-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={PASSKEY_NAME_MAX} autoComplete="off" />
          </Field>
          {!passkeysSupported() && <Callout variant="warning">Этот браузер не поддерживает passkey.</Callout>}
          {error && <Callout variant="error">{error}</Callout>}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={add.isPending || !passkeysSupported()}>
              {add.isPending ? <Loader2 className="animate-spin" /> : <Fingerprint />} Создать
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
