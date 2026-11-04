import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";

import { Mono } from "@/components/common";
import { authStateQuery } from "@/lib/auth-query";
import { Section } from "@/pages/settings/parts";

/**
 * Jackett's own admin password is no longer managed here: the jackett-ui server logs in to
 * Jackett itself with JACKETT_PASSWORD. Changing it from the UI would lock the server out.
 */
export function JackettPasswordCard() {
  const { data } = useQuery(authStateQuery);
  const failed = data?.jackett.error === "jackett_login_failed";
  return (
    <Section id="jackett-password" title="Пароль администратора Jackett" icon={Lock}>
      <p className="text-sm text-muted-foreground">
        Сервер интерфейса входит в Jackett сам. Если в Jackett задан пароль администратора, передайте его серверу в переменной окружения{" "}
        <Mono>JACKETT_PASSWORD</Mono> и перезапустите контейнер. Пароли для входа в этот интерфейс у каждого пользователя свои (профиль,
        вкладка «Пользователи»).
      </p>
      {failed && <p className="text-sm text-destructive">Сейчас сервер не может войти в Jackett: пароль в JACKETT_PASSWORD неверный.</p>}
    </Section>
  );
}
