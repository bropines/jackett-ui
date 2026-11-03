/**
 * Shared transport pieces for both clients (Jackett proxy and the UI server's /_ui/api):
 * the error class, error-body parsing and the "session lost" signal for the auth gate.
 */
import type { JackettErrorBody } from "@/api/types";

/** Error body of the UI server: `{ error: "<code>", message: "<Russian text>" }` (+ optional field path). */
export interface ServerErrorBody {
  error: string;
  message?: string;
  /** Field path for `locked` / validation errors, e.g. "auth.oidc.issuer". */
  field?: string;
  path?: string;
}

export class ApiError extends Error {
  status: number;
  body?: JackettErrorBody | ServerErrorBody;
  /** Machine-readable code from the UI server (`setup_required`, `locked`, `rate_limited`, …). */
  code?: string;
  /** Seconds from `Retry-After` (429). */
  retryAfter?: number;
  /** Field path the error refers to (server validation / `locked`). */
  field?: string;
  constructor(status: number, message: string, body?: JackettErrorBody | ServerErrorBody, code?: string) {
    super(message);
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

/** Human-readable error text for toasts and error states. */
export function errText(err: unknown): string {
  if (err instanceof ApiError) return err.message || `HTTP ${err.status}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Russian fallbacks for server error codes that come without a message. */
const CODE_TEXT: Record<string, string> = {
  setup_required: "Нужно задать пароль администратора",
  unauthorized: "Сессия истекла, войдите снова",
  invalid_credentials: "Неверный пароль",
  rate_limited: "Слишком много попыток",
  locked: "Настройка задана переменной окружения",
  jackett_unreachable: "Jackett недоступен",
  jackett_login_failed: "Неверный пароль Jackett (JACKETT_PASSWORD)",
  csrf: "Запрос отклонён (CSRF)",
};

export function codeText(code: string | undefined): string | undefined {
  return code ? CODE_TEXT[code] : undefined;
}

/**
 * Builds an ApiError from a failed response. Understands both Jackett bodies
 * (`{result:"error", error:"<text>"}`) and UI server bodies (`{error:"<code>", message}`).
 */
export async function errorFromResponse(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  let body: (JackettErrorBody & ServerErrorBody) | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") body = parsed as JackettErrorBody & ServerErrorBody;
  } catch {
    /* not JSON */
  }
  // UI server: `error` is a code (snake_case) and `message` the text. Jackett: `error` is the text.
  const isServer = !!body && (typeof body.message === "string" || (body.result !== "error" && /^[a-z0-9_]+$/.test(body.error ?? "")));
  const code = isServer ? body?.error : undefined;
  let message = isServer ? body?.message || codeText(code) || code : body?.error;
  message ||= text.slice(0, 300) || `HTTP ${res.status}`;

  const err = new ApiError(res.status, message, body, code);
  const field = isServer ? (body?.field ?? body?.path) : undefined;
  if (field) err.field = field;
  if (res.status === 429) {
    const ra = Number(res.headers.get("Retry-After"));
    err.retryAfter = Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : undefined;
    if (!body?.message) err.message = rateLimitText(err.retryAfter);
  }
  return err;
}

export function rateLimitText(seconds: number | undefined): string {
  return seconds ? `Слишком много попыток, подождите ${seconds} с` : "Слишком много попыток, подождите немного";
}

/**
 * An external auth proxy (oauth2-proxy & co) in front of us answers an expired session
 * with a redirect to the IdP. fetch() can't follow that cross-origin, so the caller reloads
 * the page and lets the browser do the login round-trip.
 */
export function isAuthProxyRedirect(res: Response): boolean {
  return res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
}

/* ── Session events ─────────────────────────────────────────────────────── */

type Listener = (reason: string) => void;
const listeners = new Set<Listener>();

/**
 * Subscribes to "re-check the auth state" signals: a protected call answered 401 /
 * `setup_required` (our session is gone) or the server reported a Jackett problem.
 */
export function onAuthRecheck(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function emitAuthRecheck(reason: string) {
  listeners.forEach((l) => l(reason));
}

/** Codes after which the gate must re-read /_ui/api/auth/state. */
export const RECHECK_CODES = new Set(["setup_required", "jackett_unreachable", "jackett_login_failed"]);

/** Emits the recheck signal when `err` means "session gone" or "Jackett problem". */
export function maybeRecheck(err: ApiError) {
  if (err.status === 401 || (err.code && RECHECK_CODES.has(err.code))) emitAuthRecheck(err.code ?? String(err.status));
}
