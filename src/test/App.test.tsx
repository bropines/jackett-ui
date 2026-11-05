/** Whole-app tests through the real router: role-aware nav, settings tabs by role, invite page, read-only indexers. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, ApiError, serverApi, type IndexerSummary } from "@/api";
import { ThemeProvider } from "@/lib/theme-provider";
import { createAppRouter } from "@/router";
import { authAs, authState, me, publicInvite, uiSettings } from "@/test/fixtures/auth";

import indexersSample from "../../contract/indexers.sample.json";

function renderApp(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(qc, createMemoryHistory({ initialEntries: [path] }));
  render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return router;
}

const configured = (indexersSample as IndexerSummary[]).slice(0, 2).map((x) => ({ ...x, configured: true }));

beforeEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  vi.spyOn(api, "configuredIndexers").mockResolvedValue(configured);
  vi.spyOn(api, "indexers").mockResolvedValue(indexersSample as IndexerSummary[]);
  vi.spyOn(api, "serverConfig").mockRejectedValue(new ApiError(403, "Недостаточно прав"));
  vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettings());
  vi.spyOn(serverApi, "users").mockResolvedValue([]);
  vi.spyOn(serverApi, "invites").mockResolvedValue([]);
});

const nav = () => screen.findByRole("navigation", { name: "Основное меню" });

describe("role-aware navigation", () => {
  it("viewer: search and trackers only", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authAs("viewer"));
    renderApp("/indexers");
    const n = await nav();
    expect(within(n).getByRole("link", { name: "Поиск" })).toBeInTheDocument();
    expect(within(n).getByRole("link", { name: "Трекеры" })).toBeInTheDocument();
    expect(within(n).queryByRole("link", { name: "Настройки" })).toBeNull();
    expect(within(n).queryByRole("link", { name: "Журнал" })).toBeNull();
    expect(api.serverConfig).not.toHaveBeenCalled();
  });

  it("editor: logs but no settings", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authAs("editor"));
    renderApp("/indexers");
    const n = await nav();
    expect(within(n).getByRole("link", { name: "Журнал" })).toBeInTheDocument();
    expect(within(n).queryByRole("link", { name: "Настройки" })).toBeNull();
  });

  it("admin: everything", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authAs("admin"));
    renderApp("/indexers");
    const n = await nav();
    expect(within(n).getByRole("link", { name: "Настройки" })).toBeInTheDocument();
    expect(within(n).getByRole("link", { name: "Журнал" })).toBeInTheDocument();
  });

  it("shows the red banner when login is disabled (anonymous admin)", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState({ disabled: true, user: null }));
    renderApp("/indexers");
    expect(await screen.findByText(/Вход отключён: любой, кто откроет адрес/)).toBeInTheDocument();
    expect(within(await nav()).getByRole("link", { name: "Настройки" })).toBeInTheDocument();
  });

  it("user menu: name, role, profile, logout", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authAs("editor"));
    const user = userEvent.setup();
    renderApp("/indexers");
    await user.click(await screen.findByRole("button", { name: "Пользователь: Thero" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("thero · Редактор")).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Профиль/ })).toHaveAttribute("href", "/profile");
    expect(within(menu).getByRole("menuitem", { name: /^Выйти$/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Выйти на всех устройствах/ })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /Настройки/ })).toBeNull();
  });
});

describe("settings by role", () => {
  it("non-admin opening /settings gets «Недостаточно прав»", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authAs("editor"));
    renderApp("/settings?tab=users");
    expect(await screen.findByText("Недостаточно прав")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(serverApi.users).not.toHaveBeenCalled();
  });

  it("admin sees the tabs; the tab follows ?tab=", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authAs("admin"));
    const user = userEvent.setup();
    const router = renderApp("/settings?tab=users");
    const users = await screen.findByRole("tab", { name: /Пользователи/ });
    expect(users).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Панель/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Jackett/ })).toBeInTheDocument();
    await waitFor(() => expect(serverApi.users).toHaveBeenCalled());

    await user.click(screen.getByRole("tab", { name: /Панель/ }));
    expect(await screen.findByRole("checkbox", { name: /Пароль/ })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toEqual({}));

    await user.click(screen.getByRole("tab", { name: /Jackett/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "jackett" }));
  });
});

describe("indexers for viewers", () => {
  it("is read-only", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authAs("viewer"));
    renderApp("/indexers?add=1");
    await screen.findByRole("list", { name: "Подключённые трекеры" });
    expect(screen.queryByRole("button", { name: /Добавить трекер/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Проверить все/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Проверить$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Настроить/ })).toBeNull();
    // ?add=1 does not open the catalog for viewers.
    expect(api.indexers).not.toHaveBeenCalled();
  });

  it("editors can manage", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authAs("editor"));
    renderApp("/indexers");
    expect(await screen.findByRole("button", { name: /Добавить трекер/ })).toBeInTheDocument();
  });
});

describe("invite page", () => {
  it("is public and creates the account with username + password", async () => {
    const state = vi.spyOn(serverApi, "authState").mockResolvedValue(authState({ authenticated: false, user: null }));
    const get = vi.spyOn(serverApi, "invite").mockResolvedValue(publicInvite());
    const accept = vi.spyOn(serverApi, "acceptInvite").mockResolvedValue(undefined);
    const user = userEvent.setup();
    const router = renderApp("/invite/tok123");

    expect(await screen.findByText("Вася")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("tok123");
    expect(screen.getByText("Редактор")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Продолжить через GitHub/ })).toHaveAttribute("href", "/_ui/auth/github/start?invite=tok123");
    // Outside the app shell / auth gate.
    expect(screen.queryByRole("navigation", { name: "Основное меню" })).toBeNull();

    await user.type(screen.getByLabelText("Имя пользователя"), "vasya");
    await user.type(screen.getByLabelText("Пароль"), "long-password");
    await user.type(screen.getByLabelText("Ещё раз"), "long-password");
    state.mockResolvedValue(authAs("editor"));
    await user.click(screen.getByRole("button", { name: /Создать аккаунт/ }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith("tok123", { username: "vasya", password: "long-password" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("provider-only invite has no password form", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState({ authenticated: false, user: null }));
    vi.spyOn(serverApi, "invite").mockResolvedValue(publicInvite({ methods: [{ id: "oidc", name: "Authentik" }] }));
    renderApp("/invite/tok123");
    expect(await screen.findByRole("link", { name: /Продолжить через Authentik/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Пароль")).toBeNull();
  });

  it.each([
    [new ApiError(404, "x", { error: "invite_not_found" }, "invite_not_found"), "Приглашение не найдено"],
    [new ApiError(410, "x", { error: "invite_expired" }, "invite_expired"), "Срок приглашения истёк"],
    [new ApiError(410, "x", { error: "invite_used" }, "invite_used"), "Приглашение уже использовано"],
    [new ApiError(410, "x"), "Срок приглашения истёк"],
  ])("shows a dead invite (%#)", async (err, text) => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState({ authenticated: false, user: null }));
    vi.spyOn(serverApi, "invite").mockRejectedValue(err);
    renderApp("/invite/bad");
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByLabelText("Пароль")).toBeNull();
  });
});

describe("welcome page (login methods)", () => {
  it("admin: password, passkey and provider cards; enables a verified provider with the full methods object", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authAs("admin"));
    vi.spyOn(serverApi, "me").mockResolvedValue(me({ identities: [] }));
    vi.spyOn(serverApi, "myPasskeys").mockResolvedValue([]);
    const put = vi.spyOn(serverApi, "putSettings").mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderApp("/welcome?step=methods");

    expect(await screen.findByRole("heading", { name: "Способы входа" })).toBeInTheDocument();
    const password = screen.getByRole("region", { name: "Пароль" });
    expect(await within(password).findByText("задан")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Passkey" })).toBeInTheDocument();

    // OIDC: verified and on → link button with the welcome return path.
    const oidc = await screen.findByRole("region", { name: "Authentik" });
    expect(within(oidc).getByRole("link", { name: /Привязать к моему аккаунту/ })).toHaveAttribute(
      "href",
      "/_ui/auth/oidc/start?link=1&return=%2Fwelcome%3Fstep%3Dmethods",
    );
    // GitHub: verified but off → "Включить вход".
    const github = screen.getByRole("region", { name: "GitHub" });
    await user.click(within(github).getByRole("button", { name: /Включить вход/ }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith({ auth: { methods: { password: true, passkey: false, oidc: true, google: false, github: true, header: false } } }),
    );
    // Google: not configured → only "Настроить", which opens the provider form.
    const google = screen.getByRole("region", { name: "Google" });
    expect(within(google).queryByRole("button", { name: /Включить вход/ })).toBeNull();
    await user.click(within(google).getByRole("button", { name: /Настроить/ }));
    const dialog = await screen.findByRole("dialog", { name: /Настроить Google/ });
    expect(within(dialog).getByText("https://jackett.example.com/_ui/auth/google/callback")).toBeInTheDocument();
  });

  it("viewer: no provider cards", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authAs("viewer"));
    vi.spyOn(serverApi, "me").mockResolvedValue(me());
    vi.spyOn(serverApi, "myPasskeys").mockResolvedValue([]);
    renderApp("/welcome?step=methods");
    expect(await screen.findByRole("region", { name: "Passkey" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "GitHub" })).toBeNull();
    expect(serverApi.getSettings).not.toHaveBeenCalled();
  });
});
