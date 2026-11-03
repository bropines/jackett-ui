import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { IndexerSummary } from "@/api";
import sample from "../../../contract/indexers.sample.json";
import { CatalogDialog } from "./CatalogDialog";

const all = sample as IndexerSummary[];

describe("CatalogDialog", () => {
  it("filters by search and picks the first match on Enter", async () => {
    vi.useFakeTimers();
    const onPick = vi.fn();
    render(<CatalogDialog open onOpenChange={() => undefined} indexers={all} onPick={onPick} />);
    expect(screen.getByText(`Найдено: ${all.length}`)).toBeInTheDocument();

    const input = screen.getByLabelText("Поиск трекера");
    fireEvent.change(input, { target: { value: "rutor" } });
    act(() => vi.advanceTimersByTime(200));
    const expected = all.filter((x) => /rutor/i.test(`${x.id} ${x.name} ${x.description}`)).length;
    expect(screen.getByText(`Найдено: ${expected}`)).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]?.[0].id).toBe("rutor");

    fireEvent.click(screen.getByRole("button", { name: /Сбросить/ }));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByText(`Найдено: ${all.length}`)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("filters by category chip", () => {
    render(<CatalogDialog open onOpenChange={() => undefined} indexers={all} onPick={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "XXX" }));
    expect(screen.getByRole("button", { name: "XXX" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(`Найдено: ${all.length}`)).not.toBeInTheDocument();
  });
});
