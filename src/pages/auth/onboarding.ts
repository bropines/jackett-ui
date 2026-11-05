import type { OnboardingRequest, SetupRequest } from "@/api/server";
import { emailError, newPasswordError, normalizeEmail, usernameError } from "@/lib/auth";

export type OnboardingMode = "replace" | "add";

export interface AccountForm {
  username: string;
  name: string;
  email: string;
  password: string;
  repeat: string;
}

export type AccountErrors = Partial<Record<"username" | "email" | "password", string>>;

export function validateAccount(f: AccountForm): AccountErrors {
  const e: AccountErrors = {};
  const u = usernameError(f.username);
  if (u) e.username = u;
  const m = emailError(f.email);
  if (m) e.email = m;
  const p = newPasswordError(f.password, f.repeat);
  if (p) e.password = p;
  return e;
}

/** Body of `POST /onboarding` for "replace" / "add": e-mail omitted when empty. */
export function onboardingBody(mode: OnboardingMode, f: AccountForm): OnboardingRequest {
  const email = normalizeEmail(f.email);
  return {
    mode,
    username: f.username.trim().toLowerCase(),
    name: f.name.trim(),
    ...(email ? { email } : {}),
    password: f.password,
  };
}

/** Body of `POST /auth/setup`: name and e-mail omitted when empty. */
export function setupBody(f: AccountForm): SetupRequest {
  const email = normalizeEmail(f.email);
  const name = f.name.trim();
  return {
    username: f.username.trim().toLowerCase(),
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    password: f.password,
  };
}

/** Which field a server error belongs to (by code or `field`). */
export function serverErrorField(code: string | undefined, field: string | undefined): keyof AccountErrors | undefined {
  if (code === "username_taken" || code === "invalid_username" || field === "username") return "username";
  if (code === "email_taken" || code === "invalid_email" || field === "email") return "email";
  if (field === "password") return "password";
  return undefined;
}
