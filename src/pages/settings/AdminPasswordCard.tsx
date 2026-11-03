import { useMutation } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "@/api";
import { ConfirmDialog, Field, toastError } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Section, SecretInput } from "@/pages/settings/parts";

export function passwordError(pw: string, repeat: string): string | undefined {
  if (!pw) return undefined;
  if (repeat && pw !== repeat) return "Пароли не совпадают";
  return undefined;
}

export function AdminPasswordCard() {
  const [pw, setPw] = useState("");
  const [repeat, setRepeat] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  const set = useMutation({
    mutationFn: (password: string) => api.setAdminPassword(password),
    onSuccess: (_d, password) => {
      setPw("");
      setRepeat("");
      setConfirmRemove(false);
      toast.success(password ? "Пароль установлен" : "Пароль убран");
    },
    onError: toastError,
  });

  const mismatch = passwordError(pw, repeat);
  const canSet = pw !== "" && pw === repeat && !set.isPending;

  return (
    <Section
      id="admin-password"
      title="Пароль администратора"
      icon={Lock}
      description="Обычно не нужен, если интерфейс закрыт SSO. Если пароль задан, интерфейс будет спрашивать его при входе."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSet) set.mutate(pw);
        }}
      >
        {/* Hidden username helps password managers associate the entry. */}
        <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Новый пароль" htmlFor="admin-pw">
            <SecretInput id="admin-pw" value={pw} onChange={setPw} autoComplete="new-password" />
          </Field>
          <Field label="Ещё раз" htmlFor="admin-pw2" error={mismatch}>
            <SecretInput id="admin-pw2" value={repeat} onChange={setRepeat} autoComplete="new-password" invalid={!!mismatch} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!canSet}>
            Сохранить пароль
          </Button>
          <Button type="button" variant="outline" onClick={() => setConfirmRemove(true)} disabled={set.isPending}>
            Убрать пароль
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Убрать пароль?"
        description="Интерфейс и API (кроме поиска по ключу) станут доступны без пароля. Делайте это, только если Jackett закрыт SSO или доступен лишь в локальной сети."
        confirmLabel="Убрать"
        destructive
        pending={set.isPending}
        onConfirm={() => set.mutate("")}
      />
    </Section>
  );
}
