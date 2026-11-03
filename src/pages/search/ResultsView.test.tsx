import { fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SearchIndexerStatus, SearchResponse } from "@/api";
import { TooltipProvider } from "@/components/ui/misc";

import { IndexerStrip } from "./IndexerStrip";
import { toRows } from "./logic";
import { ResultsView } from "./ResultsView";

const fixture = JSON.parse(readFileSync(join(process.cwd(), "contract/results-all.json"), "utf8")) as SearchResponse;

describe("ResultsView (mobile cards; jsdom matchMedia never matches)", () => {
  it("renders the first page sorted by seeders, filters, and shows actions", () => {
    const rows = toRows(fixture.Results);
    render(
      <TooltipProvider>
        <ResultsView rows={rows} only={null} onOnly={() => undefined} />
      </TooltipProvider>,
    );
    const cards = screen.getAllByRole("listitem");
    expect(cards).toHaveLength(100);
    const maxSeeders = Math.max(...fixture.Results.map((r) => r.Seeders ?? 0));
    const top = fixture.Results.find((r) => r.Seeders === maxSeeders)!;
    expect(within(cards[0]!).getByText(top.Title)).toBeInTheDocument();
    expect(within(cards[0]!).getByLabelText("Открыть magnet")).toHaveAttribute("href", top.MagnetUri);
    expect(within(cards[0]!).getByLabelText("Страница на трекере")).toHaveAttribute("target", "_blank");

    fireEvent.change(screen.getByLabelText("Фильтр результатов"), { target: { value: "zzzz-nothing" } });
    expect(screen.getByText("Нет совпадений")).toBeInTheDocument();
  });

  it("hides actions without data", () => {
    const rows = toRows([{ ...fixture.Results[0]!, MagnetUri: null, Details: null }]);
    render(
      <TooltipProvider>
        <ResultsView rows={rows} only={null} onOnly={() => undefined} />
      </TooltipProvider>,
    );
    expect(screen.queryByLabelText("Открыть magnet")).toBeNull();
    expect(screen.queryByLabelText("Копировать magnet")).toBeNull();
    expect(screen.getByLabelText("Скачать .torrent")).toBeInTheDocument();
  });
});

describe("IndexerStrip", () => {
  const statuses: SearchIndexerStatus[] = [
    { ID: "rutor", Name: "RuTor", Status: 2, Results: 100, Error: null, ElapsedTime: 230 },
    { ID: "kinozal", Name: "Kinozal", Status: 2, Results: 5, Error: null, ElapsedTime: 1400 },
    {
      ID: "rutracker",
      Name: "RuTracker",
      Status: 1,
      Results: 0,
      Error: "Jackett.Common.IndexerException: Login failed\n   at Jackett.Foo()\n   at Bar()",
      ElapsedTime: 3000,
    },
  ];

  it("shows the first error line and the full trace on demand", () => {
    render(
      <TooltipProvider>
        <IndexerStrip indexers={statuses} only={null} onOnly={() => undefined} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /RuTracker/ }));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Login failed");
    expect(alert).not.toHaveTextContent("at Bar()");
    fireEvent.click(within(alert).getByRole("button", { name: "Подробности" }));
    expect(alert).toHaveTextContent("at Bar()");
  });

  it("toggles the only-this-tracker filter", () => {
    const onOnly = vi.fn();
    render(
      <TooltipProvider>
        <IndexerStrip indexers={statuses} only={null} onOnly={onOnly} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Kinozal/ }));
    expect(onOnly).toHaveBeenCalledWith("kinozal");
  });
});
