import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  CheckCircle2,
  KeyRound,
  LogOut,
  MailPlus,
  MoreVertical,
  Shield,
  Trash2,
  Unlink,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { errText, qk, serverApi, type Identity, type Invite, type ProviderId, type Role, type UserEntry, type UserPatch } from "@/api";
import { ProviderIcon } from "@/components/auth/ProviderIcon";
import { RoleBadge } from "@/components/auth/RoleBadge";
import { Callout, ConfirmDialog, EmptyState, ErrorState, RelativeTime } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/misc";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PROVIDER_NAMES } from "@/lib/auth";
import { authStateQuery } from "@/lib/auth-query";
import { formatDateTime, plural } from "@/lib/format";
import { useMediaQuery } from "@/pages/search/useMediaQuery";
import { CreateUserDialog, InviteDialog, ResetPasswordDialog, RoleDialog, UserTokensDialog } from "@/pages/settings/users/dialogs";
import { sortUsers } from "@/pages/settings/users/logic";

type Pending =
  | { kind: "delete"; user: UserEntry }
  | { kind: "unlink"; user: UserEntry; provider: ProviderId }
  | { kind: "disable"; user: UserEntry }
  | null;

function Identities({ items }: { items: Identity[] }) {
  if (!items.length) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {items.map((i) => (
        <span key={`${i.provider}:${i.label}`} title={`${PROVIDER_NAMES[i.provider] ?? i.provider}: ${i.label}`} className="inline-flex text-muted-foreground">
          <ProviderIcon id={i.provider} className="h-4 w-4" />
          <span className="sr-only">
            {PROVIDER_NAMES[i.provider] ?? i.provider}: {i.label}
          </span>
        </span>
      ))}
    </span>
  );
}

function UserActions({
  user,
  isSelf,
  onRole,
  onPassword,
  onTokens,
  onToggle,
  onLogout,
  onUnlink,
  onDelete,
}: {
  user: UserEntry;
  isSelf: boolean;
  onRole: () => void;
  onPassword: () => void;
  onTokens: () => void;
  onToggle: () => void;
  onLogout: () => void;
  onUnlink: (p: ProviderId) => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Действия: ${user.name || user.username}`}>
          <MoreVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onSelect={onRole}>
          <Shield /> Изменить роль
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onPassword}>
          <KeyRound /> Задать пароль
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onTokens}>
          <KeyRound /> API-токены ({user.tokenCount ?? 0})
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onLogout}>
          <LogOut /> Завершить сеансы
        </DropdownMenuItem>
        {!isSelf && (
          <DropdownMenuItem onSelect={onToggle}>
            {user.disabled ? <CheckCircle2 /> : <Ban />} {user.disabled ? "Включить" : "Отключить"}
          </DropdownMenuItem>
        )}
        {user.identities.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Привязанные аккаунты</DropdownMenuLabel>
            {user.identities.map((i) => (
              <DropdownMenuItem key={`${i.provider}:${i.label}`} onSelect={() => onUnlink(i.provider)}>
                <Unlink /> Отвязать {PROVIDER_NAMES[i.provider] ?? i.provider}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {!isSelf && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
              <Trash2 /> Удалить
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InvitesList({ invites, onRevoke, pending }: { invites: Invite[]; onRevoke: (inv: Invite) => void; pending: boolean }) {
  if (!invites.length) return null;
  return (
    <section aria-labelledby="invites-title" className="space-y-2">
      <h2 id="invites-title" className="text-sm font-semibold">
        Ожидают ответа
      </h2>
      <Card className="divide-y shadow-none">
        {invites.map((inv) => (
          <div key={inv.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <MailPlus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">{inv.name || "Без имени"}</span>
                <RoleBadge role={inv.role} />
              </div>
              <div className="text-xs text-muted-foreground">до {formatDateTime(inv.expiresAt)}</div>
            </div>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => onRevoke(inv)} aria-label={`Отозвать приглашение ${inv.name}`}>
              <X /> Отозвать
            </Button>
          </div>
        ))}
      </Card>
    </section>
  );
}

/** «Пользователи» tab (admin): users, roles, invites. */
export function UsersTab() {
  const qc = useQueryClient();
  const { data: auth } = useQuery(authStateQuery);
  const selfId = auth?.user?.id;
  const usersQ = useQuery({ queryKey: qk.users, queryFn: () => serverApi.users() });
  const invitesQ = useQuery({ queryKey: qk.invites, queryFn: () => serverApi.invites() });
  const desktop = useMediaQuery("(min-width: 768px)");

  const [inviteOpen, setInviteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [roleFor, setRoleFor] = useState<UserEntry | null>(null);
  const [passwordFor, setPasswordFor] = useState<UserEntry | null>(null);
  const [tokensFor, setTokensFor] = useState<UserEntry | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [actionError, setActionError] = useState("");

  const users = useMemo(() => sortUsers(usersQ.data ?? []), [usersQ.data]);
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.users });

  const patch = useMutation({
    mutationFn: ({ user, patch }: { user: UserEntry; patch: UserPatch }) => serverApi.updateUser(user.id, patch),
    onMutate: () => setActionError(""),
    onSuccess: (_r, { patch }) => {
      refresh();
      setRoleFor(null);
      setPasswordFor(null);
      setPending(null);
      toast.success(patch.password ? "Пароль задан" : patch.role ? "Роль изменена" : patch.disabled !== undefined ? (patch.disabled ? "Пользователь отключён" : "Пользователь включён") : "Сохранено");
      // Our own role may have changed.
      void qc.invalidateQueries({ queryKey: qk.authState });
    },
    onError: (e) => {
      setRoleFor(null);
      setPasswordFor(null);
      setPending(null);
      setActionError(errText(e));
    },
  });

  const simple = useMutation({
    mutationFn: async (a: { kind: "delete" | "logout" | "unlink"; user: UserEntry; provider?: ProviderId }) => {
      if (a.kind === "delete") return serverApi.deleteUser(a.user.id);
      if (a.kind === "logout") return serverApi.logoutUser(a.user.id);
      return serverApi.unlinkUserIdentity(a.user.id, a.provider!);
    },
    onMutate: () => setActionError(""),
    onSuccess: (_r, a) => {
      refresh();
      setPending(null);
      toast.success(a.kind === "delete" ? "Пользователь удалён" : a.kind === "logout" ? "Сеансы завершены" : "Аккаунт отвязан");
    },
    onError: (e) => {
      setPending(null);
      setActionError(errText(e));
    },
  });

  const revokeInvite = useMutation({
    mutationFn: (inv: Invite) => serverApi.deleteInvite(inv.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.invites });
      toast.success("Приглашение отозвано");
    },
    onError: (e) => setActionError(errText(e)),
  });

  const actionsFor = (u: UserEntry) => (
    <UserActions
      user={u}
      isSelf={u.id === selfId}
      onRole={() => setRoleFor(u)}
      onPassword={() => setPasswordFor(u)}
      onTokens={() => setTokensFor(u)}
      onToggle={() => (u.disabled ? patch.mutate({ user: u, patch: { disabled: false } }) : setPending({ kind: "disable", user: u }))}
      onLogout={() => simple.mutate({ kind: "logout", user: u })}
      onUnlink={(provider) => setPending({ kind: "unlink", user: u, provider })}
      onDelete={() => setPending({ kind: "delete", user: u })}
    />
  );

  const nameCell = (u: UserEntry) => (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="truncate font-medium">{u.name || u.username}</span>
        {u.id === selfId && <span className="text-xs text-muted-foreground">(вы)</span>}
        {u.disabled && <Badge variant="outline">отключён</Badge>}
      </div>
      <div className="truncate font-mono text-xs text-muted-foreground">{u.username}</div>
    </div>
  );

  let list: React.ReactNode;
  if (usersQ.isPending) {
    list = <Skeleton className="h-40 w-full rounded-xl" />;
  } else if (usersQ.isError) {
    list = <ErrorState error={usersQ.error} onRetry={() => void usersQ.refetch()} />;
  } else if (users.length === 0) {
    list = (
      <Card className="shadow-none">
        <EmptyState icon={Users} title="Пользователей пока нет" />
      </Card>
    );
  } else if (desktop) {
    list = (
      <Card className="overflow-hidden shadow-none">
        <Table aria-label="Пользователи">
          <TableHeader>
            <TableRow>
              <TableHead>Пользователь</TableHead>
              <TableHead>Роль</TableHead>
              <TableHead>Аккаунты</TableHead>
              <TableHead>Токены</TableHead>
              <TableHead>Последний вход</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Действия</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id} className={u.disabled ? "opacity-60" : undefined}>
                <TableCell>{nameCell(u)}</TableCell>
                <TableCell>
                  <RoleBadge role={u.role} />
                </TableCell>
                <TableCell>
                  <Identities items={u.identities} />
                </TableCell>
                <TableCell className="tabular-nums">{u.tokenCount ?? 0}</TableCell>
                <TableCell>
                  <RelativeTime iso={u.lastLoginAt} never="никогда" />
                </TableCell>
                <TableCell>{actionsFor(u)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    );
  } else {
    list = (
      <Card className="divide-y shadow-none">
        <ul aria-label="Пользователи" className="divide-y">
          {users.map((u) => (
            <li key={u.id} className={u.disabled ? "flex items-start gap-3 px-4 py-3 opacity-60" : "flex items-start gap-3 px-4 py-3"}>
              <div className="min-w-0 flex-1 space-y-1.5">
                {nameCell(u)}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <RoleBadge role={u.role} />
                  <Identities items={u.identities} />
                  <span>
                    {u.tokenCount ?? 0} {plural(u.tokenCount ?? 0, ["токен", "токена", "токенов"])}
                  </span>
                  <span>
                    вход: <RelativeTime iso={u.lastLoginAt} never="никогда" />
                  </span>
                </div>
              </div>
              {actionsFor(u)}
            </li>
          ))}
        </ul>
      </Card>
    );
  }

  const p = pending;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-sm text-muted-foreground">
          {usersQ.data ? `${users.length} ${plural(users.length, ["пользователь", "пользователя", "пользователей"])}` : "Пользователи панели"}
        </p>
        <Button variant="outline" onClick={() => setCreateOpen(true)}>
          <UserPlus /> Создать с паролем
        </Button>
        <Button onClick={() => setInviteOpen(true)}>
          <MailPlus /> Пригласить
        </Button>
      </div>

      {actionError && (
        <Callout variant="error" title="Не получилось">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1">{actionError}</span>
            <button type="button" className="shrink-0 underline-offset-2 hover:underline" onClick={() => setActionError("")}>
              Скрыть
            </button>
          </div>
        </Callout>
      )}

      {list}

      {invitesQ.data && <InvitesList invites={invitesQ.data} onRevoke={(inv) => revokeInvite.mutate(inv)} pending={revokeInvite.isPending} />}

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
      <RoleDialog
        user={roleFor}
        onOpenChange={(o) => !o && setRoleFor(null)}
        pending={patch.isPending}
        onSave={(role: Role) => roleFor && patch.mutate({ user: roleFor, patch: { role } })}
      />
      <ResetPasswordDialog
        user={passwordFor}
        onOpenChange={(o) => !o && setPasswordFor(null)}
        pending={patch.isPending}
        onSave={(password) => passwordFor && patch.mutate({ user: passwordFor, patch: { password } })}
      />
      <UserTokensDialog user={tokensFor} onOpenChange={(o) => !o && setTokensFor(null)} />

      <ConfirmDialog
        open={p !== null}
        onOpenChange={(o) => !o && !simple.isPending && !patch.isPending && setPending(null)}
        title={
          p?.kind === "delete"
            ? `Удалить ${p.user.name || p.user.username}?`
            : p?.kind === "disable"
              ? `Отключить ${p.user.name || p.user.username}?`
              : p?.kind === "unlink"
                ? `Отвязать ${PROVIDER_NAMES[p.provider] ?? p.provider}?`
                : ""
        }
        description={
          p?.kind === "delete"
            ? "Пользователь и все его API-токены будут удалены. Это нельзя отменить."
            : p?.kind === "disable"
              ? "Пользователь не сможет войти, его сеансы и API-токены перестанут работать. Потом его можно включить."
              : "Пользователь больше не сможет входить через этот аккаунт."
        }
        confirmLabel={p?.kind === "delete" ? "Удалить" : p?.kind === "disable" ? "Отключить" : "Отвязать"}
        destructive
        pending={simple.isPending || patch.isPending}
        onConfirm={() => {
          if (!p) return;
          if (p.kind === "disable") patch.mutate({ user: p.user, patch: { disabled: true } });
          else if (p.kind === "delete") simple.mutate({ kind: "delete", user: p.user });
          else simple.mutate({ kind: "unlink", user: p.user, provider: p.provider });
        }}
      />
    </div>
  );
}
