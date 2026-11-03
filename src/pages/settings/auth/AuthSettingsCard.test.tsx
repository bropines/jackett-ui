import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, serverApi } from "@/api";
import { TooltipProvider } from "@/components/ui/misc";
import { AuthSettingsCard } from "@/pages/settings/auth/AuthSettingsCard";
import { uiSettings, uiSettingsPassword } from "@/test/fixtures/auth";

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <AuthSettingsCard />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("AuthSettingsCard", () => {
  it("disables locked fields with the env var hint", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettings());
    wrap();
    const issuer = await screen.findByLabelText("Issuer");
    expect(issuer).toBeDisabled();
    expect(screen.getByText("задано переменной окружения OIDC_ISSUER")).toBeInTheDocument();
    expect(screen.getByLabelText("Время жизни сеанса")).toBeDisabled();
    expect(screen.getByLabelText("Название на кнопке")).toBeEnabled();
    expect(screen.getAllByText("проверено").length).toBeGreaterThan(0);
    expect(screen.getByText("https://jackett.example.com/_ui/auth/github/callback")).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: /Сохранить/ }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]![0]).toEqual({ auth: { providers: { oidc: { providerName: "Keycloak" } } } });
  });

  it("keeps SSO unavailable until a provider is verified", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettingsPassword());
    wrap();
    const sso = await screen.findByRole("radio", { name: /Внешний вход/ });
    expect(sso).toBeDisabled();
    expect(screen.getByText(/нажмите «Проверить вход»: так вы не потеряете доступ/)).toBeInTheDocument();
    expect(screen.getByText("Внешний вход сейчас запрещён всем")).toBeInTheDocument();
  });

  it("asks for confirmation before turning login off", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettingsPassword());
    const put = vi.spyOn(serverApi, "putSettings").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole("radio", { name: /Без входа/ }));
    await user.click(screen.getByRole("button", { name: /Сохранить/ }));
    expect(put).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Отключить вход" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith({ auth: { mode: "none" }, confirm: true }));
  });

  it("shows server field errors inline", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettings());
    const err = new ApiError(409, "Поле задано переменной окружения", { error: "locked" }, "locked");
    err.field = "auth.providers.oidc.providerName";
    vi.spyOn(serverApi, "putSettings").mockRejectedValue(err);
    const user = userEvent.setup();
    wrap();
    const name = await screen.findByLabelText("Название на кнопке");
    await user.type(name, "!");
    await user.click(screen.getByRole("button", { name: /Сохранить/ }));
    expect(await screen.findByText("Поле задано переменной окружения")).toBeInTheDocument();
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
    expect(await screen.findByText("проверено")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Внешний вход/ })).toBeEnabled();
  });
});
