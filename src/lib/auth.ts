import type { AuthMode, AuthState, ProviderId } from "@/api/server";

export const MIN_PASSWORD = 8;

/** Default button names; the server sends the actual ones in `auth/state`. */
export const PROVIDER_NAMES: Record<ProviderId, string> = { oidc: "SSO", google: "Google", github: "GitHub" };

/** Short label of the login mode (menu, settings). */
export function modeLabel(mode: AuthMode): string {
  switch (mode) {
    case "password":
      return "Вход по паролю";
    case "sso":
      return "Внешний вход (SSO)";
    case "header":
      return "Заголовок от прокси";
    case "none":
      return "Без входа";
  }
}

/** Validates a new password + repeat. Returns a Russian error or undefined. */
export function newPasswordError(pw: string, repeat: string, { requireRepeat = true } = {}): string | undefined {
  if (pw.length < MIN_PASSWORD) return `Минимум ${MIN_PASSWORD} символов`;
  if (requireRepeat && pw !== repeat) return "Пароли не совпадают";
  return undefined;
}

/** Codes from `?authError=` after a failed OIDC callback. */
const AUTH_ERRORS: Record<string, string> = {
  state_mismatch: "Попытка входа устарела или начата в другой вкладке. Попробуйте ещё раз.",
  nonce_mismatch: "Попытка входа устарела или начата в другой вкладке. Попробуйте ещё раз.",
  flow_expired: "Вход занял больше 10 минут. Попробуйте ещё раз.",
  code_exchange_failed: "Провайдер входа не принял код авторизации. Проверьте client ID и секрет.",
  invalid_id_token: "Провайдер входа вернул недействительный токен.",
  user_not_allowed: "Этому пользователю вход запрещён: его нет в списках разрешённых e-mail, групп или пользователей GitHub.",
  email_not_verified: "Провайдер не подтвердил e-mail этого аккаунта.",
  provider_disabled: "Этот способ входа отключён.",
  idp_error: "Провайдер входа вернул ошибку или вход был отменён.",
  oidc_not_configured: "Вход через SSO не настроен.",
  not_configured: "Этот способ входа не настроен.",
  oidc_unavailable: "Провайдер входа недоступен.",
};

export function authErrorText(code: string): string {
  return AUTH_ERRORS[code] ?? `Не удалось войти (${code}).`;
}

/** One or two letters for the avatar: "admin" → "A", "john.doe@x" → "JD". */
export function initials(user: string | null | undefined): string {
  const name = (user ?? "").split("@")[0] ?? "";
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "") : name.slice(0, 1);
  return letters.toUpperCase() || "?";
}

/** Russian text for a Jackett problem reported by `auth/state` or a 502 from the proxy. */
export function jackettErrorText(code: string | undefined): { title: string; description: string } {
  if (code === "jackett_login_failed") {
    return {
      title: "Неверный пароль Jackett (JACKETT_PASSWORD)",
      description:
        "Сервер интерфейса не смог войти в Jackett. Укажите пароль администратора Jackett в переменной окружения JACKETT_PASSWORD и перезапустите контейнер.",
    };
  }
  return {
    title: "Jackett недоступен",
    description: "Сервер интерфейса не может подключиться к Jackett. Проверьте, что Jackett запущен и адрес JACKETT_URL верный.",
  };
}

export function isLoggedIn(s: AuthState | undefined): boolean {
  return !!s && !s.setupRequired && s.authenticated;
}

/** Logging out only makes sense with our own session (password / SSO). */
export function canLogout(s: AuthState | undefined): boolean {
  return !!s && (s.mode === "password" || s.mode === "sso");
}
