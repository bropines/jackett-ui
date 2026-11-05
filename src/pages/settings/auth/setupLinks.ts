import type { ProviderId } from "@/api";

export type SetupLink = { label: string; href: string };

/** Origin of the redirect URL ("" when it is not a valid URL). */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * Links that open the provider's "create OAuth client" page. GitHub takes the app name,
 * homepage and callback in the query, so its form comes pre-filled.
 */
export function providerSetupLinks(id: ProviderId, redirectUrl: string): SetupLink[] {
  switch (id) {
    case "github": {
      const q = new URLSearchParams();
      q.set("oauth_application[name]", "Jackett");
      const home = originOf(redirectUrl);
      if (home) q.set("oauth_application[url]", home);
      if (redirectUrl) q.set("oauth_application[callback_url]", redirectUrl);
      return [{ label: "Создать OAuth App на GitHub", href: `https://github.com/settings/applications/new?${q.toString()}` }];
    }
    case "google":
      return [
        { label: "Создать клиент OAuth", href: "https://console.cloud.google.com/auth/clients/create" },
        { label: "Экран согласия", href: "https://console.cloud.google.com/auth/branding" },
      ];
    default:
      return [];
  }
}

/** Short steps shown under the links. */
export const SETUP_STEPS: Partial<Record<ProviderId, string[]>> = {
  google: [
    "Если проекта нет, Google попросит создать его и заполнить экран согласия (имя приложения и почта).",
    "Тип приложения: «Веб-приложение». В «Authorized redirect URIs» вставьте адрес возврата ниже.",
    "Скопируйте Client ID и Client secret сюда.",
  ],
  github: [
    "Форма уже заполнена: название, адрес панели и адрес возврата. Нажмите «Register application».",
    "Скопируйте Client ID, затем нажмите «Generate a new client secret» и скопируйте секрет сюда.",
  ],
};
