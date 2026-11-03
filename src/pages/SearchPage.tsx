import { PageHeader } from "@/components/common";

export interface SearchPageSearch {
  q?: string;
  t?: string;
  c?: string;
}

// Placeholder: implemented by a separate task (see AGENTS.md).
export function SearchPage() {
  return <PageHeader title="Поиск" />;
}
