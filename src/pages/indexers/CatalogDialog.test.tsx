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

describe("CatalogDialog multi-select", () => {
  it("ticks several trackers and adds them at once", () => {
    // jsdom has no layout: give the virtualized list a viewport so rows render.
    const h = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    const w = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    const onAddMany = vi.fn();
    const onPick = vi.fn();
    render(<CatalogDialog open onOpenChange={() => undefined} indexers={all} onPick={onPick} onAddMany={onAddMany} />);
    expect(screen.queryByRole("button", { name: /Добавить выбранные/ })).not.toBeInTheDocument();

    const boxes = screen.getAllByRole("checkbox", { name: /^Отметить / });
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(boxes[1] as HTMLElement);
    expect(screen.getByText("Выбрано: 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Добавить выбранные (2)" }));
    expect(onPick).not.toHaveBeenCalled();
    expect(onAddMany).toHaveBeenCalledTimes(1);
    expect(onAddMany.mock.calls[0]?.[0]).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Снять выделение" }));
    expect(screen.queryByText(/Выбрано:/)).not.toBeInTheDocument();
    h.mockRestore();
    w.mockRestore();
  });

  it("hides checkboxes without onAddMany", () => {
    render(<CatalogDialog open onOpenChange={() => undefined} indexers={all} onPick={() => undefined} />);
    expect(screen.queryAllByRole("checkbox", { name: /^Отметить / })).toHaveLength(0);
  });
});
