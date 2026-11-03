import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, MonitorSmartphone, Settings } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { serverApi } from "@/api";
import { toastError } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { canLogout, initials, modeLabel } from "@/lib/auth";
import { authStateQuery, resetSession } from "@/lib/auth-query";

export function UserMenu() {
  const qc = useQueryClient();
  const { data: s } = useQuery(authStateQuery);
  const logout = useMutation({
    mutationFn: (all: boolean) => (all ? serverApi.logoutAll() : serverApi.logout()),
    onSettled: () => void resetSession(qc),
    onError: toastError,
  });
  if (!s) return null;

  const user = s.user || (s.mode === "none" ? "гость" : "admin");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-9 gap-2 px-1.5 sm:px-2" aria-label={`Пользователь: ${user}`}>
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
            aria-hidden
          >
            {initials(user)}
          </span>
          <span className="hidden max-w-[12rem] truncate text-sm sm:inline">{user}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="space-y-0.5">
          <div className="truncate">{user}</div>
          <div className="text-xs font-normal text-muted-foreground">{modeLabel(s.mode)}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings" hash="auth">
            <Settings className="mr-2 h-4 w-4" /> Вход и безопасность
          </Link>
        </DropdownMenuItem>
        {canLogout(s) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={logout.isPending} onSelect={() => logout.mutate(false)}>
              <LogOut className="mr-2 h-4 w-4" /> Выйти
            </DropdownMenuItem>
            <DropdownMenuItem disabled={logout.isPending} onSelect={() => logout.mutate(true)}>
              <MonitorSmartphone className="mr-2 h-4 w-4" /> Выйти на всех устройствах
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
