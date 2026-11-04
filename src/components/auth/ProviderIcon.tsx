import { Github, LogIn } from "lucide-react";

import type { ProviderId } from "@/api";

/** Brand-neutral icons: lucide's GitHub mark, a generic one for the rest. */
export function ProviderIcon({ id, className }: { id: ProviderId; className?: string }) {
  return id === "github" ? <Github className={className} aria-hidden /> : <LogIn className={className} aria-hidden />;
}
