import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, serverApi } from "@/api";
import { TooltipProvider } from "@/components/ui/misc";
import { ProfilePage } from "@/pages/ProfilePage";
import { authState, me, passkey, token } from "@/test/fixtures/auth";

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ProfilePage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const SECRET = "jui_AbCdEfGhIjKlMnOpQrStUvWxYz012345";

beforeEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/profile");
  vi.spyOn(serverApi, "myPasskeys").mockResolvedValue([]);
  vi.spyOn(serverApi, "authState").mockResolvedValue(
    authState({ methods: { password: true, providers: [{ id: "github", name: "GitHub" }, { id: "oidc", name: "Authentik" }], header: false } }),
  );
});

describe("ProfilePage", () => {
  it("lists passkeys, edits the e-mail and shows would_lock_out on delete", async () => {
    vi.spyOn(serverApi, "me").mockResolvedValue(me());
    vi.spyOn(serverApi, "myPasskeys").mockResolvedValue([passkey({ synced: true }), passkey({ id: "pk_2", name: "Ключ", cloneWarning: true, lastUsedAt: null })]);
    const del = vi.spyOn(serverApi, "deleteMyPasskey").mockRejectedValue(new ApiError(409, "После этого войти будет невозможно", undefined, "would_lock_out"));
    const update = vi.spyOn(serverApi, "updateMe").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap();

    const list = await screen.findByRole("list", { name: "Мои passkey" });
    expect(within(list).getByText("Windows")).toBeInTheDocument();
    expect(within(list).getByText("синхронизирован")).toBeInTheDocument();
    expect(within(list).getByText(/скопирован/)).toBeInTheDocument();
    expect(within(list).getByText("никогда")).toBeInTheDocument();

    await user.click(within(list).getByRole("button", { name: "Удалить Ключ" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Удалить" }));
    expect(del).toHaveBeenCalledWith("pk_2");
    expect(await screen.findByText("После этого войти будет невозможно")).toBeInTheDocument();

    const email = screen.getByLabelText("Почта");
    expect(email).toHaveValue("admin@example.com");
    await user.clear(email);
    await user.type(email, "New@Example.com");
    await user.click(within(screen.getByRole("region", { name: "Учётная запись" })).getByRole("button", { name: /Сохранить/ }));
    expect(update).toHaveBeenCalledWith({ email: "new@example.com" });
  });


  it("lists tokens without secrets and linked accounts with link / unlink", async () => {
    vi.spyOn(serverApi, "me").mockResolvedValue(me());
    wrap();
    const list = await screen.findByRole("list", { name: "Мои API-токены" });
    expect(within(list).getByText("qBittorrent")).toBeInTheDocument();
    expect(within(list).getByText("jui_Ab3d…")).toBeInTheDocument();
    expect(within(list).getByText(/192\.168\.1\.20/)).toBeInTheDocument();
    expect(within(list).getByText("бессрочный")).toBeInTheDocument();

    const ids = screen.getByRole("list", { name: "Привязанные аккаунты" });
    expect(within(ids).getByText(/octocat/)).toBeInTheDocument();
    expect(within(ids).getByRole("button", { name: /Отвязать/ })).toBeInTheDocument();
    expect(within(ids).getByRole("link", { name: /Привязать/ })).toHaveAttribute("href", "/_ui/auth/oidc/start?link=1&return=%2Fprofile");
  });

  it("creates a token and shows it once with ready-to-paste client settings", async () => {
    vi.spyOn(serverApi, "me").mockResolvedValue(me({ tokens: [] }));
    const create = vi.spyOn(serverApi, "createMyToken").mockResolvedValue({ ...token({ id: "t_new", name: "Sonarr", prefix: "jui_AbCd" }), token: SECRET });
    const user = userEvent.setup();
    // user-event installs its own clipboard stub in setup().
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    wrap();

    await user.click(await screen.findByRole("button", { name: /Создать токен/ }));
    const form = await screen.findByRole("dialog", { name: "Новый API-токен" });
    await user.click(within(form).getByRole("button", { name: /Создать/ }));
    expect(within(form).getByText(/Укажите название/)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    await user.type(within(form).getByLabelText("Название"), "Sonarr");
    await user.click(within(form).getByRole("radio", { name: "90 дней" }));
    await user.click(within(form).getByRole("button", { name: /Создать/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "Sonarr", expiresInDays: 90 }));

    const shown = await screen.findByRole("dialog", { name: /Токен «Sonarr» создан/ });
    expect(within(shown).getByText(SECRET)).toBeInTheDocument();
    expect(within(shown).getByText(window.location.origin)).toBeInTheDocument();
    expect(within(shown).getByText(`${window.location.origin}/api/v2.0/indexers/{id}/results/torznab/`)).toBeInTheDocument();
    expect(within(shown).getByText(`${window.location.origin}/api/v2.0/indexers/all/results/torznab/?apikey=${SECRET}`)).toBeInTheDocument();

    await user.click(within(shown).getByRole("button", { name: "Копировать jackett.json" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const json = JSON.parse(writeText.mock.calls[0]![0] as string);
    expect(json).toEqual({ api_key: SECRET, thread_count: 20, tracker_first: false, url: window.location.origin });

    await user.click(within(shown).getByRole("button", { name: /Готово/ }));
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull());
  });

  it("creates a never-expiring token without expiresInDays", async () => {
    vi.spyOn(serverApi, "me").mockResolvedValue(me({ tokens: [] }));
    const create = vi.spyOn(serverApi, "createMyToken").mockResolvedValue({ ...token(), token: SECRET });
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole("button", { name: /Создать токен/ }));
    const form = await screen.findByRole("dialog", { name: "Новый API-токен" });
    await user.type(within(form).getByLabelText("Название"), "qBittorrent");
    await user.click(within(form).getByRole("button", { name: /Создать/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "qBittorrent" }));
  });

  it("revokes a token after confirmation", async () => {
    vi.spyOn(serverApi, "me").mockResolvedValue(me());
    const del = vi.spyOn(serverApi, "deleteMyToken").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole("button", { name: "Отозвать токен qBittorrent" }));
    expect(del).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Отозвать" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("t_qbit000000000001"));
  });

  it("shows identity_in_use coming back from the link flow", async () => {
    window.history.replaceState(null, "", "/profile?authError=identity_in_use");
    vi.spyOn(serverApi, "me").mockResolvedValue(me());
    wrap();
    expect(await screen.findByText("Этот аккаунт уже привязан к другому пользователю.")).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("changes the password with the current one", async () => {
    vi.spyOn(serverApi, "me").mockResolvedValue(me());
    const change = vi.spyOn(serverApi, "changeMyPassword").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap();
    await user.type(await screen.findByLabelText("Текущий пароль"), "old-password");
    await user.type(screen.getByLabelText("Новый пароль"), "new-password");
    await user.type(screen.getByLabelText("Ещё раз"), "new-password");
    await user.click(screen.getByRole("button", { name: /Сменить пароль/ }));
    await waitFor(() => expect(change).toHaveBeenCalledWith({ current: "old-password", new: "new-password" }));
  });
});
