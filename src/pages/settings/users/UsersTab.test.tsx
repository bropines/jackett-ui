import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, serverApi } from "@/api";
import { TooltipProvider } from "@/components/ui/misc";
import { UsersTab } from "@/pages/settings/users/UsersTab";
import { authState, invites, users } from "@/test/fixtures/auth";

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <UsersTab />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(serverApi, "authState").mockResolvedValue(authState());
  vi.spyOn(serverApi, "users").mockResolvedValue(users());
  vi.spyOn(serverApi, "invites").mockResolvedValue(invites());
});

/** Opens the actions menu of `name` (jsdom: no media query matches → mobile cards). */
async function openActions(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("button", { name: `Действия: ${name}` }));
  return screen.findByRole("menu");
}

describe("UsersTab", () => {
  it("lists users with role, state, accounts and pending invites", async () => {
    wrap();
    const list = await screen.findByRole("list", { name: "Пользователи" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText("Админ", { selector: "span.truncate" })).toBeInTheDocument();
    expect(within(items[0]!).getByText("(вы)")).toBeInTheDocument();
    expect(within(items[1]!).getByText("Редактор")).toBeInTheDocument();
    expect(within(items[1]!).getByText("GitHub: thero")).toBeInTheDocument();
    expect(within(items[2]!).getByText("отключён")).toBeInTheDocument();
    expect(screen.getByText("Ожидают ответа")).toBeInTheDocument();
    expect(screen.getByText("Вася")).toBeInTheDocument();
  });

  it("shows e-mail, passkey count and the AUTH_PASSWORD badge; edits name and e-mail", async () => {
    const update = vi.spyOn(serverApi, "updateUser").mockRejectedValueOnce(new ApiError(409, "Эта почта уже указана у другого пользователя", undefined, "email_taken"));
    const user = userEvent.setup();
    wrap();
    const list = await screen.findByRole("list", { name: "Пользователи" });
    const first = within(list).getAllByRole("listitem")[0]!;
    expect(within(first).getByText("admin@example.com")).toBeInTheDocument();
    expect(within(first).getByText("из AUTH_PASSWORD")).toBeInTheDocument();
    expect(within(first).getByText("Passkey: 1")).toBeInTheDocument();

    const menu = await openActions(user, "Thero");
    await user.click(within(menu).getByRole("menuitem", { name: /Имя и почта/ }));
    const dialog = await screen.findByRole("dialog", { name: /Изменить: thero/ });
    await user.type(within(dialog).getByLabelText("Почта"), "Thero@Example.com");
    await user.click(within(dialog).getByRole("button", { name: /Сохранить/ }));
    expect(await within(dialog).findByText("Эта почта уже указана у другого пользователя")).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith(users()[1]!.id, { email: "thero@example.com" });
  });

  it("changes a role with PATCH {role}", async () => {
    const update = vi.spyOn(serverApi, "updateUser").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap();
    const menu = await openActions(user, "Thero");
    await user.click(within(menu).getByRole("menuitem", { name: /Изменить роль/ }));
    const dialog = await screen.findByRole("dialog", { name: /Роль: Thero/ });
    await user.click(within(dialog).getByRole("radio", { name: /Админ/ }));
    await user.click(within(dialog).getByRole("button", { name: /Сохранить/ }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(users()[1]!.id, { role: "admin" }));
  });

  it("shows last_admin from the server", async () => {
    const err = new ApiError(409, "Нельзя убрать последнего администратора", { error: "last_admin" }, "last_admin");
    vi.spyOn(serverApi, "updateUser").mockRejectedValue(err);
    const user = userEvent.setup();
    wrap();
    const menu = await openActions(user, "Админ");
    await user.click(within(menu).getByRole("menuitem", { name: /Изменить роль/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /Поиск/ }));
    await user.click(within(dialog).getByRole("button", { name: /Сохранить/ }));
    expect(await screen.findByText("Нельзя убрать последнего администратора")).toBeInTheDocument();
  });

  it("disables after confirmation, enables directly, deletes after confirmation", async () => {
    const update = vi.spyOn(serverApi, "updateUser").mockResolvedValue(undefined);
    const del = vi.spyOn(serverApi, "deleteUser").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap();

    let menu = await openActions(user, "Thero");
    await user.click(within(menu).getByRole("menuitem", { name: /Отключить/ }));
    await user.click(await screen.findByRole("button", { name: "Отключить" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(users()[1]!.id, { disabled: true }));

    menu = await openActions(user, "Гость");
    await user.click(within(menu).getByRole("menuitem", { name: /Включить/ }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(users()[2]!.id, { disabled: false }));

    menu = await openActions(user, "Гость");
    await user.click(within(menu).getByRole("menuitem", { name: /Удалить/ }));
    expect(del).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(users()[2]!.id));
  });

  it("does not offer delete / disable for yourself", async () => {
    const user = userEvent.setup();
    wrap();
    const menu = await openActions(user, "Админ");
    expect(within(menu).queryByRole("menuitem", { name: /Удалить/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /Отключить/ })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: /Отвязать OIDC|Отвязать SSO/ })).toBeInTheDocument();
  });

  it("unlinks an identity and resets a password", async () => {
    const unlink = vi.spyOn(serverApi, "unlinkUserIdentity").mockResolvedValue(undefined);
    const update = vi.spyOn(serverApi, "updateUser").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap();

    let menu = await openActions(user, "Thero");
    await user.click(within(menu).getByRole("menuitem", { name: /Отвязать GitHub/ }));
    await user.click(await screen.findByRole("button", { name: "Отвязать" }));
    await waitFor(() => expect(unlink).toHaveBeenCalledWith(users()[1]!.id, "github"));

    menu = await openActions(user, "Thero");
    await user.click(within(menu).getByRole("menuitem", { name: /Задать пароль/ }));
    const dialog = await screen.findByRole("dialog", { name: /Новый пароль/ });
    await user.type(within(dialog).getByLabelText("Новый пароль"), "brand-new-pw");
    await user.click(within(dialog).getByRole("button", { name: /Задать пароль/ }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(users()[1]!.id, { password: "brand-new-pw" }));
  });

  it("invites: shows the one-time link with copy", async () => {
    const create = vi
      .spyOn(serverApi, "createInvite")
      .mockResolvedValue({ url: "https://jackett.example.com/invite/tok123", id: "i_new", role: "editor", name: "Петя", expiresAt: "2026-11-11T10:00:00Z" });
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole("button", { name: /Пригласить/ }));
    const dialog = await screen.findByRole("dialog", { name: "Пригласить пользователя" });
    await user.type(within(dialog).getByLabelText("Имя"), "Петя");
    await user.click(within(dialog).getByRole("radio", { name: /Редактор/ }));
    await user.clear(within(dialog).getByLabelText("Срок действия, дней"));
    await user.type(within(dialog).getByLabelText("Срок действия, дней"), "40");
    expect(within(dialog).getByText("От 1 до 30 дней")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Срок действия, дней"));
    await user.type(within(dialog).getByLabelText("Срок действия, дней"), "3");
    await user.click(within(dialog).getByRole("button", { name: /Создать ссылку/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "Петя", role: "editor", expiresInDays: 3 }));
    const done = await screen.findByRole("dialog", { name: "Ссылка-приглашение" });
    expect(within(done).getByText("https://jackett.example.com/invite/tok123")).toBeInTheDocument();
    expect(within(done).getByRole("button", { name: "Копировать ссылку" })).toBeInTheDocument();
  });

  it("revokes a pending invite", async () => {
    const del = vi.spyOn(serverApi, "deleteInvite").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole("button", { name: "Отозвать приглашение Вася" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("i_pending000000001"));
  });

  it("creates a user with a password", async () => {
    const create = vi.spyOn(serverApi, "createUser").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole("button", { name: /Создать с паролем/ }));
    const dialog = await screen.findByRole("dialog", { name: "Новый пользователь" });
    await user.type(within(dialog).getByLabelText("Имя пользователя"), "Petya");
    await user.type(within(dialog).getByLabelText("Имя"), "Петя");
    await user.type(within(dialog).getByLabelText("Пароль"), "long-password");
    await user.click(within(dialog).getByRole("button", { name: /^Создать$/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ username: "petya", name: "Петя", role: "viewer", password: "long-password" }));
  });
});
