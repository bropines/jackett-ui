import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, serverApi } from "@/api";
import { TooltipProvider } from "@/components/ui/misc";
import { LoginTab } from "@/pages/settings/login/LoginTab";
import { uiSettings, uiSettingsLockedMethods, uiSettingsPassword } from "@/test/fixtures/auth";

function wrap(onOpenTab = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <LoginTab onOpenTab={onOpenTab} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return onOpenTab;
}

const conflict = (message: string, code: string, field: string) => {
  const e = new ApiError(409, message, { error: code }, code);
  e.field = field;
  return e;
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("LoginTab", () => {
  it("shows each method as a card with status and a switch", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettings());
    wrap();
    expect(await screen.findByRole("switch", { name: "Вход по паролю" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Вход через Authentik" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Вход через GitHub" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Вход через GitHub" })).toBeEnabled(); // verified → can be turned on
    expect(screen.getByRole("switch", { name: "Вход через Google" })).toBeDisabled(); // not configured
    const google = screen.getByRole("region", { name: /Google/ });
    expect(within(google).getByText("не настроен")).toBeInTheDocument();
    expect(within(google).getByText(/Сначала нажмите «Настроить»/)).toBeInTheDocument();
    const gh = screen.getByRole("region", { name: /GitHub/ });
    expect(within(gh).getByText("настроен")).toBeInTheDocument();
    expect(within(gh).getByText("проверен")).toBeInTheDocument();
  });

  it("saves a switch at once with the complete methods object", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettings());
    const put = vi.spyOn(serverApi, "putSettings").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole("switch", { name: "Вход через GitHub" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith({ auth: { methods: { password: true, passkey: false, oidc: true, google: false, github: true, header: false } } }),
    );
  });

  it("disables the switches when AUTH_METHODS is set", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettingsLockedMethods());
    wrap();
    expect(await screen.findByRole("switch", { name: "Вход по паролю" })).toBeDisabled();
    expect(screen.getByText(/задано переменной окружения AUTH_METHODS/)).toBeInTheDocument();
  });

  it("shows would_lock_out on the card that was switched", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettings());
    vi.spyOn(serverApi, "putSettings").mockRejectedValue(conflict("После этого войти будет невозможно", "would_lock_out", "auth.methods"));
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole("switch", { name: "Вход по паролю" }));
    const card = screen.getByRole("region", { name: /Пароль/ });
    expect(await within(card).findByText("После этого войти будет невозможно")).toBeInTheDocument();
  });

  it("shows provider_not_ready on that provider's card", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettings());
    vi.spyOn(serverApi, "putSettings").mockRejectedValue(conflict("Провайдер не проверен", "provider_not_ready", "auth.methods.github"));
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole("switch", { name: "Вход через GitHub" }));
    expect(await within(screen.getByRole("region", { name: /GitHub/ })).findByText("Провайдер не проверен")).toBeInTheDocument();
  });

  it("asks for confirmation before turning login off", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettingsPassword());
    const put = vi.spyOn(serverApi, "putSettings").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole("switch", { name: "Отключить вход" }));
    expect(put).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Отключить вход" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith({ auth: { disabled: true }, confirm: true }));
  });

  it("saves header login fields with their own button", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettingsPassword());
    const put = vi.spyOn(serverApi, "putSettings").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap();
    expect(await screen.findByRole("switch", { name: "Вход через прокси" })).toBeDisabled(); // no proxy networks yet
    const card = screen.getByRole("region", { name: /Вход через прокси/ });
    const save = within(card).getByRole("button", { name: /Сохранить/ });
    expect(save).toBeDisabled();
    await user.type(within(card).getByLabelText("Адреса прокси"), "10.0.0.0/33");
    expect(within(card).getByText(/Не похоже на сеть CIDR/)).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.clear(within(card).getByLabelText("Адреса прокси"));
    await user.type(within(card).getByLabelText("Адреса прокси"), "10.0.0.0/8");
    await user.click(save);
    await waitFor(() => expect(put).toHaveBeenCalledWith({ auth: { header: { trusted: ["10.0.0.0/8"] } } }));
  });

  it("points to «Общее» when passkeys don't work at this address", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettingsPassword());
    const user = userEvent.setup();
    const onOpenTab = wrap();
    const card = await screen.findByRole("region", { name: /Passkey/ });
    expect(within(card).getByText(/только по https-адресу/)).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Указать внешний адрес" }));
    expect(onOpenTab).toHaveBeenCalledWith("general");
  });

  it("sets up a provider in a dialog: env-locked fields, test login", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettings());
    const test = vi.spyOn(serverApi, "testProvider").mockResolvedValue({ url: "/_ui/auth/google/start?test=tok" });
    vi.spyOn(serverApi, "testProviderResult").mockResolvedValue({ status: "verified" });
    const win = { closed: false, opener: {}, location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    const user = userEvent.setup();
    wrap();

    await user.click(within(await screen.findByRole("region", { name: /Authentik/ })).getByRole("button", { name: /Настроить/ }));
    const oidc = await screen.findByRole("dialog");
    expect(within(oidc).getByLabelText("Issuer")).toBeDisabled();
    expect(within(oidc).getByText("задано переменной окружения OIDC_ISSUER")).toBeInTheDocument();
    await user.click(within(oidc).getAllByRole("button", { name: "Закрыть" })[0]!);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(within(screen.getByRole("region", { name: /Google/ })).getByRole("button", { name: /Настроить/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("https://jackett.example.com/_ui/auth/google/callback")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Client ID"), "gid");
    await user.click(within(dialog).getByRole("button", { name: /Проверить вход/ }));
    await waitFor(() => expect(test).toHaveBeenCalledWith("google", { clientId: "gid" }));
    await waitFor(() => expect(win.location.href).toBe("/_ui/auth/google/start?test=tok"));
    expect(await within(dialog).findByText("проверено")).toBeInTheDocument();
  });
});
