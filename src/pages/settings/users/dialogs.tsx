import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Trash2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import { ApiError, errText, qk, serverApi, type CreatedInvite, type Role, type UserEntry } from "@/api";
import { RolePicker } from "@/components/auth/RolePicker";
import { Callout, CopyField, EmptyState, ErrorState, Field, Mono, RelativeTime } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { EMAIL_MAX, emailError, MIN_PASSWORD, newPasswordError, normalizeEmail, usernameError } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { SecretInput } from "@/pages/settings/parts";
import { absoluteUrl, INVITE_DEFAULT_DAYS, INVITE_MAX_DAYS, inviteDaysError } from "@/pages/settings/users/logic";

function FormError({ children }: { children: ReactNode }) {
  return children ? <Callout variant="error">{children}</Callout> : null;
}

/** Server error that belongs to the e-mail field (email_taken / invalid_email). */
const emailServerError = (e: unknown) =>
  e instanceof ApiError && (e.code === "email_taken" || e.code === "invalid_email" || e.field === "email") ? errText(e) : undefined;

function EmailInput({ id, value, onChange, invalid }: { id: string; value: string; onChange: (v: string) => void; invalid?: boolean }) {
  return (
    <Input
      id={id}
      type="email"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      maxLength={EMAIL_MAX}
      autoComplete="off"
      autoCapitalize="none"
      spellCheck={false}
      aria-invalid={invalid ? true : undefined}
    />
  );
}

/* ── Invite ── */

export function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [days, setDays] = useState(String(INVITE_DEFAULT_DAYS));
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const create = useMutation({
    mutationFn: () => serverApi.createInvite({ name: name.trim(), role, expiresInDays: Number(days) }),
    onSuccess: (inv) => {
      setCreated(inv);
      void qc.invalidateQueries({ queryKey: qk.invites });
    },
  });
  const daysErr = inviteDaysError(days);

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      // The link is shown once: forget it on close.
      setCreated(null);
      setName("");
      setRole("viewer");
      setDays(String(INVITE_DEFAULT_DAYS));
      create.reset();
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (daysErr || create.isPending) return;
    create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{created ? "Ссылка-приглашение" : "Пригласить пользователя"}</DialogTitle>
          <DialogDescription>
            {created
              ? "Отправьте ссылку человеку. Она одноразовая и показывается только сейчас."
              : "Человек откроет ссылку, задаст имя и пароль или войдёт через провайдера."}
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="space-y-3">
            <CopyField value={absoluteUrl(created.url)} label="Копировать ссылку" />
            {created.expiresAt && <p className="text-xs text-muted-foreground">Действует до {formatDateTime(created.expiresAt)}.</p>}
            <DialogFooter>
              <Button onClick={() => close(false)}>Готово</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <Field label="Имя" htmlFor="inv-name" hint="Как показывать этого пользователя. Можно оставить пустым">
              <Input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoComplete="off" />
            </Field>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">Роль</legend>
              <RolePicker id="inv-role" value={role} onChange={setRole} />
            </fieldset>
            <Field label="Срок действия, дней" htmlFor="inv-days" error={daysErr} hint={`От 1 до ${INVITE_MAX_DAYS}`}>
              <Input id="inv-days" value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" className="w-28" aria-invalid={daysErr ? true : undefined} />
            </Field>
            <FormError>{create.isError ? errText(create.error) : null}</FormError>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => close(false)}>
                Отмена
              </Button>
              <Button type="submit" disabled={!!daysErr || create.isPending}>
                {create.isPending && <Loader2 className="animate-spin" />} Создать ссылку
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ── Create with password ── */

export function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [pw, setPw] = useState("");
  const [touched, setTouched] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      serverApi.createUser({
        username: username.trim().toLowerCase(),
        name: name.trim(),
        ...(normalizeEmail(email) ? { email: normalizeEmail(email) } : {}),
        role,
        password: pw,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.users });
      close(false);
    },
  });
  const userErr = usernameError(username);
  const pwErr = newPasswordError(pw, pw, { requireRepeat: false });
  const emailErr = emailError(email);
  const serverEmailErr = emailServerError(create.error);

  function close(o: boolean) {
    onOpenChange(o);
    if (!o) {
      setUsername("");
      setName("");
      setEmail("");
      setRole("viewer");
      setPw("");
      setTouched(false);
      create.reset();
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (userErr || pwErr || emailErr || create.isPending) return;
    create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Новый пользователь</DialogTitle>
          <DialogDescription>Сообщите ему имя пользователя и пароль; пароль он сможет сменить в профиле.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Имя пользователя" htmlFor="new-username" error={touched ? userErr : undefined}>
              <Input id="new-username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label="Имя" htmlFor="new-name">
              <Input id="new-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoComplete="off" />
            </Field>
          </div>
          <Field label="Почта" htmlFor="new-email" error={(touched ? emailErr : undefined) ?? serverEmailErr} hint="Необязательно">
            <EmailInput id="new-email" value={email} onChange={setEmail} invalid={(touched && !!emailErr) || !!serverEmailErr} />
          </Field>
          <Field label="Пароль" htmlFor="new-password" error={touched ? pwErr : undefined} hint={`Не короче ${MIN_PASSWORD} символов`}>
            <SecretInput id="new-password" value={pw} onChange={setPw} autoComplete="new-password" />
          </Field>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Роль</legend>
            <RolePicker id="new-role" value={role} onChange={setRole} />
          </fieldset>
          <FormError>{create.isError && !serverEmailErr ? errText(create.error) : null}</FormError>
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

/* ── Name and e-mail ── */

export function EditUserDialog({ user, onOpenChange }: { user: UserEntry | null; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const [login, setLogin] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const [forUser, setForUser] = useState<string | undefined>();
  if (user && user.id !== forUser) {
    setForUser(user.id);
    setLogin(user.username);
    setName(user.name ?? "");
    setEmail(user.email ?? "");
  }
  const loginDirty = !!user && login.trim().toLowerCase() !== user.username;
  const nameDirty = !!user && name.trim() !== (user.name ?? "");
  const emailDirty = !!user && normalizeEmail(email) !== (user.email ?? "");
  const save = useMutation({
    mutationFn: () =>
      serverApi.updateUser(user!.id, { ...(loginDirty ? { username: login.trim().toLowerCase() } : {}), ...(nameDirty ? { name: name.trim() } : {}), ...(emailDirty ? { email: normalizeEmail(email) } : {}) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.users });
      void qc.invalidateQueries({ queryKey: qk.authState });
      close(false);
    },
  });
  const emailErr = emailError(email);
  const serverEmailErr = emailServerError(save.error);
  const loginErr = loginDirty ? usernameError(login) : undefined;
  const serverLoginErr = save.error instanceof ApiError && save.error.field === "username" ? errText(save.error) : undefined;
  const dirty = loginDirty || nameDirty || emailDirty;

  function close(o: boolean) {
    onOpenChange(o);
    if (!o) {
      setForUser(undefined);
      setTouched(false);
      save.reset();
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (emailErr || loginErr || save.isPending || !dirty) return;
    save.mutate();
  };

  return (
    <Dialog open={!!user} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Изменить: {user?.username}</DialogTitle>
          <DialogDescription>Логин, имя и почта. Почта нужна только для справки.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Логин" htmlFor="edit-login" error={(touched ? loginErr : undefined) ?? serverLoginErr}>
            <Input
              id="edit-login"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              maxLength={32}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={(touched && !!loginErr) || !!serverLoginErr || undefined}
            />
          </Field>
          <Field label="Имя" htmlFor="edit-name">
            <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoComplete="off" />
          </Field>
          <Field label="Почта" htmlFor="edit-email" error={(touched ? emailErr : undefined) ?? serverEmailErr} hint="Пусто — удалить">
            <EmailInput id="edit-email" value={email} onChange={setEmail} invalid={(touched && !!emailErr) || !!serverEmailErr} />
          </Field>
          <FormError>{save.isError && !serverEmailErr && !serverLoginErr ? errText(save.error) : null}</FormError>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={save.isPending || !dirty}>
              {save.isPending && <Loader2 className="animate-spin" />} Сохранить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Role ── */

export function RoleDialog({
  user,
  onOpenChange,
  onSave,
  pending,
}: {
  user: UserEntry | null;
  onOpenChange: (open: boolean) => void;
  onSave: (role: Role) => void;
  pending?: boolean;
}) {
  const [role, setRole] = useState<Role>(user?.role ?? "viewer");
  const [forUser, setForUser] = useState(user?.id);
  if (user && user.id !== forUser) {
    setForUser(user.id);
    setRole(user.role);
  }
  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Роль: {user?.name || user?.username}</DialogTitle>
          <DialogDescription>Смена роли завершит сеансы пользователя.</DialogDescription>
        </DialogHeader>
        <RolePicker id="edit-role" value={role} onChange={setRole} />
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button type="button" disabled={pending || role === user?.role} onClick={() => onSave(role)}>
            {pending && <Loader2 className="animate-spin" />} Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Reset password ── */

export function ResetPasswordDialog({
  user,
  onOpenChange,
  onSave,
  pending,
}: {
  user: UserEntry | null;
  onOpenChange: (open: boolean) => void;
  onSave: (password: string) => void;
  pending?: boolean;
}) {
  const [pw, setPw] = useState("");
  const [touched, setTouched] = useState(false);
  const err = newPasswordError(pw, pw, { requireRepeat: false });
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setPw("");
      setTouched(false);
    }
  };
  return (
    <Dialog open={!!user} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Новый пароль: {user?.name || user?.username}</DialogTitle>
          <DialogDescription>Сеансы пользователя завершатся. Сообщите ему новый пароль.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (!err) onSave(pw);
          }}
        >
          <Field label="Новый пароль" htmlFor="reset-pw" error={touched ? err : undefined} hint={`Не короче ${MIN_PASSWORD} символов`}>
            <SecretInput id="reset-pw" value={pw} onChange={setPw} autoComplete="new-password" />
          </Field>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Задать пароль
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── A user's API tokens ── */

export function UserTokensDialog({ user, onOpenChange }: { user: UserEntry | null; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.userTokens(user?.id ?? ""), queryFn: () => serverApi.userTokens(user!.id), enabled: !!user });
  const revoke = useMutation({
    mutationFn: (id: string) => serverApi.deleteToken(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.userTokens(user?.id ?? "") });
      void qc.invalidateQueries({ queryKey: qk.users });
    },
  });
  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>API-токены: {user?.name || user?.username}</DialogTitle>
          <DialogDescription>Отозванный токен перестаёт работать сразу.</DialogDescription>
        </DialogHeader>
        {q.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} className="py-6" />
        ) : q.data.length === 0 ? (
          <EmptyState icon={KeyRound} title="Токенов нет" className="py-6" />
        ) : (
          <ul className="divide-y rounded-md border">
            {q.data.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{t.name}</div>
                  <div className="text-xs text-muted-foreground">
                    <Mono>{t.prefix}…</Mono> · использован <RelativeTime iso={t.lastUsedAt} never="никогда" />
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Отозвать токен ${t.name}`}
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(t.id)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {revoke.isError && <Callout variant="error">{errText(revoke.error)}</Callout>}
      </DialogContent>
    </Dialog>
  );
}
