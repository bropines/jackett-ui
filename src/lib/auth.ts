import type { AuthState, ProviderId, Role } from "@/api/server";

export const MIN_PASSWORD = 8;

/** Default button names; the server sends the actual ones in `auth/state`. */
export const PROVIDER_NAMES: Record<ProviderId, string> = { oidc: "SSO", google: "Google", github: "GitHub" };

/** Role names as shown in the UI. */
export const ROLE_LABELS: Record<Role, string> = { admin: "Админ", editor: "Редактор", viewer: "Поиск" };

/** What each role may do (one line, for selects and hints). */
export const ROLE_HINTS: Record<Role, string> = {
  viewer: "Поиск и скачивание, список трекеров, свои API-токены",
  editor: "Плюс добавление и настройка трекеров, журнал",
  admin: "Всё, включая настройки и пользователей",
};

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

/** True when `role` is `min` or higher. */
export function roleAtLeast(role: Role | null | undefined, min: Role): boolean {
  return !!role && RANK[role] !== undefined && RANK[role] >= RANK[min];
}

/** Effective role of the current visitor: login off = anonymous admin. */
export function currentRole(s: AuthState | undefined): Role | null {
  if (!s) return null;
  if (s.disabled) return "admin";
  if (!s.authenticated) return null;
  return s.user?.role ?? "viewer";
}

/** Username rule from the spec: [a-z0-9._-]{2,32}. */
export const USERNAME_RE = /^[a-z0-9._-]{2,32}$/;

export function usernameError(v: string): string | undefined {
  if (!v.trim()) return "Укажите имя пользователя";
  if (!USERNAME_RE.test(v.trim().toLowerCase())) return "2–32 символа: латиница, цифры, точка, дефис, подчёркивание";
  return undefined;
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
  identity_in_use: "Этот аккаунт уже привязан к другому пользователю.",
  link_session_mismatch: "Сеанс сменился во время привязки. Попробуйте ещё раз.",
  not_logged_in: "Чтобы привязать аккаунт, сначала войдите.",
  invite_not_found: "Приглашение не найдено.",
  invite_expired: "Срок приглашения истёк.",
  invite_used: "Приглашение уже использовано.",
  invite_invalid: "Приглашение недействительно.",
  user_disabled: "Этот пользователь отключён.",
  // codes the server uses for the link flow
  unauthorized: "Чтобы привязать аккаунт, сначала войдите.",
  wrong_session: "Сеанс сменился во время привязки. Попробуйте ещё раз.",
  provider_already_linked: "К вашей учётке уже привязан аккаунт этого провайдера. Сначала отвяжите старый.",
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

/** Logging out only makes sense with our own session (login is on). */
export function canLogout(s: AuthState | undefined): boolean {
  return !!s && !s.disabled && s.authenticated;
}

/** Display name of the current user. */
export function displayName(s: AuthState | undefined): string {
  if (!s) return "";
  if (s.user) return s.user.name || s.user.username;
  return s.disabled ? "гость" : "";
}
