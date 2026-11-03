import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { api, type LogEntry } from "@/api";
import { TooltipProvider } from "@/components/ui/misc";
import logsJson from "../../../contract/logs.json";
import { LogsPage } from "@/pages/LogsPage";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("LogsPage", () => {
  it("lists entries, filters by level and expands a stack trace", async () => {
    vi.spyOn(api, "logs").mockResolvedValue(logsJson as LogEntry[]);
    const user = userEvent.setup();
    wrap(<LogsPage />);

    const list = await screen.findByRole("list", { name: "Сообщения журнала" });
    expect(list.children).toHaveLength(49);

    await user.click(screen.getByRole("button", { name: /Ошибки\s*3/ }));
    expect(screen.getByRole("list", { name: "Сообщения журнала" }).children).toHaveLength(3);

    const first = screen.getAllByRole("button", { expanded: false })[0]!;
    await user.click(first);
    expect(first).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Копировать сообщение" })).toBeInTheDocument();
  });
});
