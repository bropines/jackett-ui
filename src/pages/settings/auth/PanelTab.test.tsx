import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, serverApi } from "@/api";
import { TooltipProvider } from "@/components/ui/misc";
import { PanelTab } from "@/pages/settings/auth/PanelTab";
import { uiSettings, uiSettingsLockedMethods, uiSettingsPassword } from "@/test/fixtures/auth";

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <PanelTab />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("PanelTab", () => {
  it("shows login methods as checkboxes and disables locked fields with the env var", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettings());
    wrap();
    expect(await screen.findByRole("checkbox", { name: /Пароль/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /OpenID Connect/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /GitHub/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /GitHub/ })).toBeEnabled(); // verified → can be turned on
    expect(screen.getByRole("checkbox", { name: /Google/ })).toBeDisabled(); // not configured
    expect(screen.getByLabelText("Issuer")).toBeDisabled();
    expect(screen.getByText("задано переменной окружения OIDC_ISSUER")).toBeInTheDocument();
    expect(screen.getByLabelText("Время жизни сеанса")).toBeDisabled();
    expect(screen.getByText("https://jackett.example.com/_ui/auth/github/callback")).toBeInTheDocument();
  });

  it("locks the whole methods block when AUTH_METHODS is set", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettingsLockedMethods());
    wrap();
    expect(await screen.findByRole("checkbox", { name: /Пароль/ })).toBeDisabled();
    expect(screen.getByText("задано переменной окружения AUTH_METHODS")).toBeInTheDocument();
  });

  it("saves only the changed fields", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettings());
    const put = vi.spyOn(serverApi, "putSettings").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap();
    const name = await screen.findByLabelText("Название на кнопке");
    expect(screen.getByRole("button", { name: /Сохранить/ })).toBeDisabled();
    await user.clear(name);
    await user.type(name, "Keycloak");
    await user.click(screen.getByRole("checkbox", { name: /GitHub/ }));
    await user.type(screen.getByLabelText("E-mail администраторов"), "boss@example.com");
    await user.click(screen.getByRole("button", { name: /Сохранить/ }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]![0]).toEqual({
      auth: {
        methods: { password: true, passkey: false, oidc: true, google: false, github: true, header: false },
        adminEmails: ["boss@example.com"],
        providers: { oidc: { providerName: "Keycloak" } },
      },
    });
  });

  it("keeps a provider method unavailable until the provider is verified", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettingsPassword());
    wrap();
    const google = await screen.findByRole("checkbox", { name: /Google/ });
    expect(google).toBeDisabled();
    expect(screen.getAllByText(/нажмите «Проверить вход»: так вы не потеряете доступ/).length).toBeGreaterThan(0);
  });

  it("asks for confirmation before turning login off", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettingsPassword());
    const put = vi.spyOn(serverApi, "putSettings").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole("switch", { name: /Отключить вход полностью/ }));
    expect(screen.getByText("Вход будет отключён")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Сохранить/ }));
    expect(put).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Отключить вход" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith({ auth: { disabled: true }, confirm: true }));
  });

  it("shows server errors (would_lock_out) and field errors inline", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettings());
    const lock = new ApiError(409, "После этого войти будет невозможно", { error: "would_lock_out" }, "would_lock_out");
    lock.field = "auth.methods";
    const put = vi.spyOn(serverApi, "putSettings").mockRejectedValue(lock);
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole("checkbox", { name: /Пароль/ }));
    await user.click(screen.getByRole("button", { name: /Сохранить/ }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(await screen.findByText("После этого войти будет невозможно")).toBeInTheDocument();
  });

  it("tests a provider: opens the URL and polls until verified", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettingsPassword());
    const test = vi.spyOn(serverApi, "testProvider").mockResolvedValue({ url: "/_ui/auth/google/start?test=tok" });
    vi.spyOn(serverApi, "testProviderResult").mockResolvedValue({ status: "verified" });
    const win = { closed: false, opener: {}, location: { href: "" }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    const user = userEvent.setup();
    wrap();

    await user.type(await screen.findByLabelText("Client ID", { selector: "#auth-google-clientId" }), "gid");
    const section = screen.getByRole("region", { name: "Google" });
    await user.click(within(section).getByRole("button", { name: /Проверить вход/ }));
    await waitFor(() => expect(test).toHaveBeenCalledWith("google", { clientId: "gid" }));
    expect(open).toHaveBeenCalled();
    await waitFor(() => expect(win.location.href).toBe("/_ui/auth/google/start?test=tok"));
    expect(await within(section).findByText("проверено")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Google/ })).toBeEnabled();
  });
});
