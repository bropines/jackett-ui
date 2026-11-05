import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, ApiError, type ConfigField, type IndexerSummary } from "@/api";
import sample from "../../../contract/indexers.sample.json";
import { CatalogDialog } from "./CatalogDialog";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn(), dismiss: vi.fn() } }));

const all = sample as IndexerSummary[];
const rutracker = JSON.parse(readFileSync(join(process.cwd(), "contract/config-rutracker.json"), "utf8")) as ConfigField[];

function render(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => vi.restoreAllMocks());

const rowButton = (name: string) => screen.getAllByRole("button").find((b) => b.textContent?.startsWith(name))!;

describe("CatalogDialog", () => {
  it("filters by search and opens the first match on Enter", async () => {
    vi.spyOn(api, "indexerConfig").mockResolvedValue(structuredClone(rutracker));
    vi.useFakeTimers();
    render(<CatalogDialog open onOpenChange={() => undefined} indexers={all} />);
    expect(screen.getByText("Выберите трекер")).toBeInTheDocument();
    expect(screen.getByText(`Найдено: ${all.length}`)).toBeInTheDocument();

    const input = screen.getByLabelText("Поиск трекера");
    fireEvent.change(input, { target: { value: "rutor" } });
    act(() => vi.advanceTimersByTime(200));
    const expected = all.filter((x) => /rutor/i.test(`${x.id} ${x.name} ${x.description}`)).length;
    expect(screen.getByText(`Найдено: ${expected}`)).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    const rutor = all.find((x) => x.id === "rutor")!;
    expect(screen.getByRole("region", { name: `Настройка: ${rutor.name}` })).toBeInTheDocument();
    expect(api.indexerConfig).toHaveBeenCalledWith("rutor");

    fireEvent.click(screen.getByRole("button", { name: /Сбросить/ }));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByText(`Найдено: ${all.length}`)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("filters by category chip", () => {
    render(<CatalogDialog open onOpenChange={() => undefined} indexers={all} />);
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
    render(<CatalogDialog open onOpenChange={() => undefined} indexers={all} onAddMany={onAddMany} />);
    expect(screen.queryByRole("button", { name: /Добавить выбранные/ })).not.toBeInTheDocument();

    const boxes = screen.getAllByRole("checkbox", { name: /^Отметить / });
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(boxes[1] as HTMLElement);
    expect(screen.getByText("Выбрано: 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Добавить выбранные (2)" }));
    expect(onAddMany).toHaveBeenCalledTimes(1);
    expect(onAddMany.mock.calls[0]?.[0]).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Снять" }));
    expect(screen.queryByText(/Выбрано:/)).not.toBeInTheDocument();
    h.mockRestore();
    w.mockRestore();
  });

  it("hides checkboxes without onAddMany", () => {
    render(<CatalogDialog open onOpenChange={() => undefined} indexers={all} />);
    expect(screen.queryAllByRole("checkbox", { name: /^Отметить / })).toHaveLength(0);
  });
});

describe("CatalogDialog right-hand pane", () => {
  it("shows the tracker, adds it and reports back; asks before switching with unsaved input", async () => {
    const h = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    const w = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(api, "indexerConfig").mockImplementation(async () => structuredClone(rutracker));
    const save = vi.spyOn(api, "saveIndexerConfig").mockResolvedValue(undefined);
    vi.spyOn(api, "testIndexer").mockResolvedValue(undefined);
    const onAdded = vi.fn();
    render(<CatalogDialog open onOpenChange={() => undefined} indexers={all} onAdded={onAdded} />);

    const [a, b] = all;
    fireEvent.click(rowButton(a!.name));
    const user = await screen.findByLabelText("Username");
    fireEvent.change(user, { target: { value: "bob" } });

    // Unsaved input: switching asks first.
    fireEvent.click(rowButton(b!.name));
    expect(await screen.findByText("Уйти без сохранения?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.getByRole("region", { name: `Настройка: ${a!.name}` })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(a!.id, expect.any(Array)));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(a!.id));
    expect(screen.getByText("Выберите трекер")).toBeInTheDocument();
    h.mockRestore();
    w.mockRestore();
  });

  it("explains a bare 500 with the error Jackett logged", async () => {
    const h = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    const w = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    const rt = all.find((x) => x.id === "rutracker") ?? { ...all[0]!, id: "rutracker", name: "RuTracker.org" };
    vi.spyOn(api, "indexerConfig").mockResolvedValue(structuredClone(rutracker));
    vi.spyOn(api, "saveIndexerConfig").mockRejectedValue(new ApiError(500, "Internal Server Error"));
    vi.spyOn(api, "logs").mockResolvedValue([
      {
        Level: "Error",
        When: new Date().toISOString(),
        Message:
          "FlareSolverrSharp.Exceptions.FlareSolverrException: Challenge detected but FlareSolverr is not configured\n\n   at Jackett.Common.Indexers.Definitions.RuTracker.ApplyConfiguration()",
      },
    ]);
    render(<CatalogDialog open onOpenChange={() => undefined} indexers={[rt]} />);
    fireEvent.click(rowButton(rt.name));
    await screen.findByLabelText("Username");
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Challenge detected but FlareSolverr is not configured")).toBeInTheDocument();
    expect(screen.getByText(/проверку Cloudflare/)).toBeInTheDocument();
    h.mockRestore();
    w.mockRestore();
  });
});
