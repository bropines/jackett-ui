import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, serverApi } from "@/api";
import { TooltipProvider } from "@/components/ui/misc";
import { GeneralTab } from "@/pages/settings/general/GeneralTab";
import { SignupSection } from "@/pages/settings/users/SignupSection";
import { uiSettings, uiSettingsPassword } from "@/test/fixtures/auth";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SignupSection", () => {
  it("saves only the changed allow-list fields", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettings());
    const put = vi.spyOn(serverApi, "putSettings").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap(<SignupSection />);
    await user.type(await screen.findByLabelText("E-mail администраторов"), "boss@example.com");
    await user.click(screen.getByRole("button", { name: /Сохранить/ }));
    await waitFor(() => expect(put).toHaveBeenCalledWith({ auth: { adminEmails: ["boss@example.com"] } }));
  });

  it("disables the lists while signup without invite is off and validates e-mails", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettingsPassword());
    const user = userEvent.setup();
    wrap(<SignupSection />);
    const emails = await screen.findByLabelText("Разрешённые e-mail");
    expect(emails).toBeDisabled();
    await user.click(screen.getByRole("switch", { name: "Пускать без приглашения" }));
    expect(emails).toBeEnabled();
    await user.type(emails, "not-an-email");
    expect(screen.getByText("Не похоже на e-mail: not-an-email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Сохранить/ })).toBeDisabled();
  });
});

describe("GeneralTab", () => {
  it("disables env-locked fields and shows the variable", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettings());
    wrap(<GeneralTab />);
    expect(await screen.findByLabelText("Время жизни сеанса")).toBeDisabled();
    expect(screen.getByText("задано переменной окружения SESSION_TTL")).toBeInTheDocument();
  });

  it("uses presets, shows the duration in words and server field errors inline", async () => {
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettingsPassword());
    const err = new ApiError(400, "Слишком коротко", { error: "invalid" }, "invalid");
    err.field = "sessionTtl";
    const put = vi.spyOn(serverApi, "putSettings").mockRejectedValue(err);
    const user = userEvent.setup();
    wrap(<GeneralTab />);
    expect(await screen.findByText(/^7 д\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Сутки" }));
    expect(screen.getByLabelText("Время жизни сеанса")).toHaveValue("24h");
    await user.click(screen.getByRole("button", { name: /Сохранить/ }));
    await waitFor(() => expect(put).toHaveBeenCalledWith({ sessionTtl: "24h" }));
    expect(await screen.findByText("Слишком коротко")).toBeInTheDocument();
  });
});
