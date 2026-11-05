import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, ApiError, emitAuthRecheck, serverApi } from "@/api";
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
  vi.spyOn(api, "serverConfig").mockRejectedValue(new Error("must not be called"));
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
    expect(screen.getByLabelText("Имя пользователя")).toHaveValue("admin");
    const [pw, pw2] = [screen.getByLabelText("Пароль"), screen.getByLabelText("Ещё раз")] as HTMLInputElement[];
    await user.type(pw!, "short");
    await user.type(pw2!, "short");
    await user.click(screen.getByRole("button", { name: /Создать и войти/ }));
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
    await user.clear(screen.getByLabelText("Имя пользователя"));
    await user.type(screen.getByLabelText("Имя пользователя"), "Boss");
    await user.click(screen.getByRole("button", { name: /Создать и войти/ }));
    expect(setup).toHaveBeenCalledWith({ username: "boss", password: "longenough1" });
    expect(await screen.findByText("APP")).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe("/welcome?step=methods");
  });

  it("shows the password login and logs in", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState({ authenticated: false, user: null }));
    const login = vi.spyOn(serverApi, "login").mockRejectedValueOnce(new ApiError(401, "x", undefined, "invalid_credentials"));
    const user = userEvent.setup();
    wrap(<App />);

    const pw = await screen.findByLabelText("Пароль");
    expect(screen.queryByRole("link", { name: /Войти через/ })).toBeNull();
    await user.type(screen.getByLabelText("Имя пользователя"), "thero");
    await user.type(pw, "wrong");
    await user.click(screen.getByRole("button", { name: /^Войти$/ }));
    expect(await screen.findByText("Неверное имя пользователя или пароль")).toBeInTheDocument();
    expect(login).toHaveBeenCalledWith({ username: "thero", password: "wrong" });

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
        authenticated: false,
        user: null,
        methods: {
          password: false,
          providers: [
            { id: "oidc", name: "Authentik" },
            { id: "github", name: "GitHub" },
          ],
          header: false,
        },
      }),
    );
    wrap(<App />);
    const oidc = await screen.findByRole("link", { name: /Войти через Authentik/ });
    expect(oidc).toHaveAttribute("href", "/_ui/auth/oidc/start?return=%2Findexers%3Fadd%3D1");
    expect(screen.getByRole("link", { name: /Войти через GitHub/ })).toHaveAttribute("href", "/_ui/auth/github/start?return=%2Findexers%3Fadd%3D1");
    expect(screen.queryByLabelText("Пароль")).toBeNull();
    expect(screen.queryByLabelText("Имя пользователя")).toBeNull();
  });

  it("shows both the password form and provider buttons", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(
      authState({ authenticated: false, user: null, methods: { password: true, providers: [{ id: "google", name: "Google" }], header: false } }),
    );
    wrap(<App />);
    expect(await screen.findByRole("link", { name: /Войти через Google/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Имя пользователя")).toBeInTheDocument();
    expect(screen.getByText("или")).toBeInTheDocument();
  });

  it("explains header-only login", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(
      authState({ authenticated: false, user: null, methods: { password: false, providers: [], header: true } }),
    );
    wrap(<App />);
    expect(await screen.findByText(/прокси-сервер авторизации/)).toBeInTheDocument();
  });

  it("shows the first-login wizard when onboarding is true and posts the account", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState({ onboarding: true }));
    const onboarding = vi.spyOn(serverApi, "onboarding").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap(<App />);

    expect(await screen.findByText("Своя учётная запись")).toBeInTheDocument();
    expect(screen.queryByText("APP")).toBeNull();
    // Fields appear after the mode is chosen.
    expect(screen.queryByLabelText("Имя пользователя")).toBeNull();
    await user.click(screen.getByRole("radio", { name: /Заменить admin/ }));
    expect(screen.getByText(/перестанет работать/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Имя пользователя"), "Bropines");
    await user.type(screen.getByLabelText("Имя"), "Bropines");
    await user.type(screen.getByLabelText("Почта"), "bad");
    await user.type(screen.getByLabelText("Пароль"), "longenough1");
    await user.type(screen.getByLabelText("Ещё раз"), "longenough1");
    await user.click(screen.getByRole("button", { name: /Сохранить/ }));
    expect(screen.getByText("Адрес вида name@example.com")).toBeInTheDocument();
    expect(onboarding).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText("Почта"));
    await user.type(screen.getByLabelText("Почта"), "Me@Example.com");
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState({ onboarding: false }));
    await user.click(screen.getByRole("button", { name: /Сохранить/ }));
    expect(onboarding).toHaveBeenCalledWith({ mode: "replace", username: "bropines", name: "Bropines", email: "me@example.com", password: "longenough1" });
    expect(await screen.findByText("APP")).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe("/welcome?step=methods");
  });

  it("shows username_taken next to the field in the wizard", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState({ onboarding: true }));
    vi.spyOn(serverApi, "onboarding").mockRejectedValue(new ApiError(409, "Такое имя пользователя уже занято", undefined, "username_taken"));
    const user = userEvent.setup();
    wrap(<App />);
    await user.click(await screen.findByRole("radio", { name: /Добавить ещё одного администратора/ }));
    await user.type(screen.getByLabelText("Имя пользователя"), "thero");
    await user.type(screen.getByLabelText("Пароль"), "longenough1");
    await user.type(screen.getByLabelText("Ещё раз"), "longenough1");
    await user.click(screen.getByRole("button", { name: /Создать и войти/ }));
    expect(await screen.findByText("Такое имя пользователя уже занято")).toBeInTheDocument();
    expect(serverApi.onboarding).toHaveBeenCalledWith({ mode: "add", username: "thero", name: "", password: "longenough1" });
  });

  it("skips the wizard after confirmation", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState({ onboarding: true }));
    const onboarding = vi.spyOn(serverApi, "onboarding").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap(<App />);
    await user.click(await screen.findByRole("button", { name: "Пропустить" }));
    const dialog = await screen.findByRole("alertdialog");
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState());
    await user.click(within(dialog).getByRole("button", { name: "Пропустить" }));
    expect(onboarding).toHaveBeenCalledWith({ mode: "skip" });
    expect(await screen.findByText("APP")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
  });

  it("logs in with a passkey and stays quiet when the user cancels", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(
      authState({ authenticated: false, user: null, methods: { password: true, passkey: true, providers: [], header: false } }),
    );
    vi.spyOn(serverApi, "passkeyLoginBegin").mockResolvedValue({ ceremony: "c1", publicKey: { challenge: "AQID" } });
    const finish = vi.spyOn(serverApi, "passkeyLoginFinish").mockRejectedValueOnce(new ApiError(401, "x", undefined, "passkey_invalid"));
    const assertion = {
      id: "Bwg",
      rawId: new Uint8Array([7, 8]).buffer,
      type: "public-key",
      response: { clientDataJSON: new Uint8Array([1]).buffer, authenticatorData: new Uint8Array([2]).buffer, signature: new Uint8Array([3]).buffer, userHandle: null },
      getClientExtensionResults: () => ({}),
    };
    const get = vi.fn().mockRejectedValueOnce(new DOMException("cancelled", "NotAllowedError")).mockResolvedValue(assertion);
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    vi.stubGlobal("navigator", { ...navigator, credentials: { get, create: vi.fn() } });
    const user = userEvent.setup();
    wrap(<App />);

    const button = await screen.findByRole("button", { name: /Войти с passkey/ });
    await user.click(button);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();

    await user.click(button);
    expect(await screen.findByText(/Passkey не подошёл/)).toBeInTheDocument();
    expect(finish).toHaveBeenCalledWith({ ceremony: "c1", credential: expect.objectContaining({ id: "Bwg", rawId: "Bwg" }) });

    finish.mockResolvedValueOnce(undefined);
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState());
    await user.click(button);
    expect(await screen.findByText("APP")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("lets everyone in when login is disabled", async () => {
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState({ disabled: true, authenticated: true, user: null }));
    wrap(<App />);
    expect(await screen.findByText("APP")).toBeInTheDocument();
  });

  it("shows authError from the URL and strips it", async () => {
    window.history.replaceState(null, "", "/?authError=user_not_allowed");
    vi.spyOn(serverApi, "authState").mockResolvedValue(
      authState({ authenticated: false, user: null, methods: { password: false, providers: [{ id: "google", name: "Google" }], header: false } }),
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
