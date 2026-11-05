import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IndexerSummary } from "@/api";
import sample from "../../../contract/indexers.sample.json";
import { PRESETS_KEY } from "./presets";
import { TrackerFilter } from "./TrackerFilter";

const indexers = [...new Map((sample as IndexerSummary[]).slice(0, 6).map((i) => [i.id, i])).values()];
const ids = indexers.map((i) => i.id);

describe("TrackerFilter", () => {
  beforeEach(() => localStorage.clear());

  it("shows chosen trackers as removable chips, collapsing the rest into +N", () => {
    const onChange = vi.fn();
    const chosen = ids.slice(0, 4);
    render(<TrackerFilter indexers={indexers} selected={chosen} onChange={onChange} />);
    expect(screen.getByRole("button", { name: `Убрать ${indexers[0]?.name}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Убрать ${indexers[1]?.name}` })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `Убрать ${indexers[2]?.name}` })).not.toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: `Убрать ${indexers[0]?.name}` }));
    expect(onChange).toHaveBeenCalledWith(chosen.slice(1));

    fireEvent.click(screen.getByRole("button", { name: "Все" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("shows no chips for 'all'", () => {
    render(<TrackerFilter indexers={indexers} selected={[]} onChange={() => undefined} />);
    expect(screen.getByRole("button", { name: /Все трекеры/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Убрать / })).not.toBeInTheDocument();
  });

  it("labels the button with a saved group that matches the selection", () => {
    localStorage.setItem(PRESETS_KEY, JSON.stringify([{ id: "p1", name: "Мои", trackers: ids.slice(0, 2) }]));
    render(<TrackerFilter indexers={indexers} selected={ids.slice(0, 2)} onChange={() => undefined} />);
    expect(screen.getByRole("button", { name: "Фильтр трекеров: группа Мои" })).toBeInTheDocument();
  });
});
