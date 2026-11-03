import { Link } from "@tanstack/react-router";

import { EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";

export function NotFoundPage() {
  return (
    <EmptyState
      title="Страница не найдена"
      action={
        <Button asChild variant="outline">
          <Link to="/">К поиску</Link>
        </Button>
      }
    />
  );
}
