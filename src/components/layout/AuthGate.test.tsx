import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, ApiError, emitAuthRecheck, serverApi, type ServerConfig } from "@/api";
import { AuthGate } from "@/components/layout/AuthGate";
import { JackettGate } from "@/components/layout/JackettGate";
import { TooltipProvider } from "@/components/ui/misc";
import { authState } from "@/test/fixtures/auth";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

const App = () => (
  <AuthGate>
    <JackettGate>
      <p>APP</p>
    </JackettGate>
  </AuthGate>
);

beforeEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  vi.spyOn(api, "serverConfig").mockResolvedValue({ api_key: "k", app_version: "v0.24" } as ServerConfig);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("AuthGate", () => {
  it("shows a loader while the state loads", () => {
    vi.spyOn(serverApi, "authState").mockReturnValue(new Promise(() => undefined));
    wrap(<App />);
    expect(screen.getByRole("status")).toHaveTextContent("Загрузка");
  });

  it("shows the setup wizard and validates it", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState({ setupRequired: true, authenticated: false }));
    const setup = vi.spyOn(serverApi, "setup").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap(<App />);

    expect(await screen.findByText(/Jackett будет доступен только после входа/)).toBeInTheDocument();
    const [pw, pw2] = [screen.getByLabelText("Пароль"), screen.getByLabelText("Ещё раз")] as HTMLInputElement[];
    await user.type(pw!, "short");
    await user.type(pw2!, "short");
    await user.click(screen.getByRole("button", { name: /Сохранить и войти/ }));
    expect(screen.getByText("Минимум 8 символов")).toBeInTheDocument();

    await user.clear(pw!);
    await user.type(pw!, "longenough1");
    await user.clear(pw2!);
    await user.type(pw2!, "longenough2");
    expect(screen.getByText("Пароли не совпадают")).toBeInTheDocument();
    expect(setup).not.toHaveBeenCalled();

    await user.clear(pw2!);
    await user.type(pw2!, "longenough1");
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState());
    await user.click(screen.getByRole("button", { name: /Сохранить и войти/ }));
    expect(setup).toHaveBeenCalledWith("longenough1");
    expect(await screen.findByText("APP")).toBeInTheDocument();
  });

  it("shows the password login and logs in", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState({ authenticated: false, user: null }));
    const login = vi.spyOn(serverApi, "login").mockRejectedValueOnce(new ApiError(401, "Неверный пароль", undefined, "invalid_credentials"));
    const user = userEvent.setup();
    wrap(<App />);

    const pw = await screen.findByLabelText("Пароль");
    expect(screen.queryByRole("link", { name: /Войти через/ })).toBeNull();
    await user.type(pw, "wrong");
    await user.click(screen.getByRole("button", { name: /^Войти$/ }));
    expect(await screen.findByText("Неверный пароль")).toBeInTheDocument();

    login.mockResolvedValueOnce(undefined);
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState());
    await user.clear(pw);
    await user.type(pw, "right-password");
    await user.click(screen.getByRole("button", { name: /^Войти$/ }));
    expect(await screen.findByText("APP")).toBeInTheDocument();
  });

  it("shows the rate limit message", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState({ authenticated: false }));
    const err = new ApiError(429, "x", undefined, "rate_limited");
    err.retryAfter = 30;
    vi.spyOn(serverApi, "login").mockRejectedValue(err);
    const user = userEvent.setup();
    wrap(<App />);
    await user.type(await screen.findByLabelText("Пароль"), "whatever1");
    await user.click(screen.getByRole("button", { name: /^Войти$/ }));
    expect(await screen.findByText(/^Слишком много попыток, подождите (30|29|28) с$/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Войти$/ })).toBeDisabled();
  });

  it("shows one button per provider linking to its start URL", async () => {
    window.history.replaceState(null, "", "/indexers?add=1");
    vi.spyOn(serverApi, "authState").mockResolvedValue(
      authState({
        mode: "sso",
        authenticated: false,
        passwordLogin: false,
        providers: [
          { id: "oidc", name: "Authentik" },
          { id: "github", name: "GitHub" },
        ],
      }),
    );
    wrap(<App />);
    const oidc = await screen.findByRole("link", { name: /Войти через Authentik/ });
    expect(oidc).toHaveAttribute("href", "/_ui/auth/oidc/start?return=%2Findexers%3Fadd%3D1");
    expect(screen.getByRole("link", { name: /Войти через GitHub/ })).toHaveAttribute("href", "/_ui/auth/github/start?return=%2Findexers%3Fadd%3D1");
    expect(screen.queryByLabelText("Пароль")).toBeNull();
  });

  it("shows authError from the URL and strips it", async () => {
    window.history.replaceState(null, "", "/?authError=user_not_allowed");
    vi.spyOn(serverApi, "authState").mockResolvedValue(
      authState({ mode: "sso", authenticated: false, providers: [{ id: "google", name: "Google" }] }),
    );
    wrap(<App />);
    expect(await screen.findByText(/вход запрещён/)).toBeInTheDocument();
    expect(window.location.search).toBe("");
    // The return path never carries the error back.
    expect(screen.getByRole("link", { name: /Войти через Google/ })).toHaveAttribute("href", "/_ui/auth/google/start?return=%2F");
  });

  it("renders the app when authenticated and goes back to login when the session is lost", async () => {
    const state = vi.spyOn(serverApi, "authState").mockResolvedValue(authState());
    wrap(<App />);
    expect(await screen.findByText("APP")).toBeInTheDocument();

    state.mockResolvedValue(authState({ authenticated: false, user: null }));
    act(() => emitAuthRecheck("401"));
    expect(await screen.findByLabelText("Пароль")).toBeInTheDocument();
  });

  it("shows a Jackett error inside the app with retry", async () => {
    const state = vi
      .spyOn(serverApi, "authState")
      .mockResolvedValue(authState({ jackett: { ok: false, error: "jackett_login_failed" } }));
    const user = userEvent.setup();
    wrap(<App />);
    expect(await screen.findByText("Неверный пароль Jackett (JACKETT_PASSWORD)")).toBeInTheDocument();
    expect(api.serverConfig).not.toHaveBeenCalled();

    state.mockResolvedValue(authState());
    await user.click(screen.getByRole("button", { name: /Повторить/ }));
    expect(await screen.findByText("APP")).toBeInTheDocument();
  });

  it("shows 'Jackett недоступен' for jackett_unreachable", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState({ jackett: { ok: false, error: "jackett_unreachable" } }));
    wrap(<App />);
    expect(await screen.findByText("Jackett недоступен")).toBeInTheDocument();
  });

  it("shows an error with retry when the server can't be reached", async () => {
    const state = vi.spyOn(serverApi, "authState").mockRejectedValue(new Error("Failed to fetch"));
    const user = userEvent.setup();
    wrap(<App />);
    // authStateQuery retries once.
    expect(await screen.findByText("Failed to fetch", {}, { timeout: 4000 })).toBeInTheDocument();
    state.mockResolvedValue(authState());
    await user.click(screen.getByRole("button", { name: /Повторить/ }));
    await waitFor(() => expect(screen.getByText("APP")).toBeInTheDocument());
  });
});
