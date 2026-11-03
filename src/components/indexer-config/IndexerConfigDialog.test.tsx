import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, ApiError, type ConfigField } from "@/api";

import { IndexerConfigDialog } from "./IndexerConfigDialog";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const rutracker = JSON.parse(readFileSync(join(process.cwd(), "contract/config-rutracker.json"), "utf8")) as ConfigField[];

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => vi.restoreAllMocks());

describe("IndexerConfigDialog", () => {
  it("renders the form, masks secrets and posts the full list on save", async () => {
    vi.spyOn(api, "indexerConfig").mockResolvedValue(structuredClone(rutracker));
    const saveSpy = vi.spyOn(api, "saveIndexerConfig").mockResolvedValue(undefined);
    vi.spyOn(api, "testIndexer").mockResolvedValue(undefined);
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    const user = userEvent.setup();

    wrap(<IndexerConfigDialog indexerId="rutracker" indexerName="RuTracker" isNew onOpenChange={onOpenChange} onSaved={onSaved} />);

    expect(screen.getByText("RuTracker")).toBeInTheDocument();
    expect(screen.getByText("Новый трекер")).toBeInTheDocument();

    const username = await screen.findByLabelText("Username");
    const password = screen.getByLabelText("Password");
    expect(password).toHaveAttribute("type", "password");
    await user.click(screen.getAllByRole("button", { name: "Показать" })[0]!);
    expect(password).toHaveAttribute("type", "text");

    await user.type(username, "bob");
    await user.type(password, "pw");
    await user.click(screen.getByLabelText("Use Magnet Links"));
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
    const [id, sent] = saveSpy.mock.calls[0]!;
    expect(id).toBe("rutracker");
    expect(sent).toHaveLength(rutracker.length);
    expect(sent.map((f) => f.id)).toEqual(rutracker.map((f) => f.id));
    expect(sent[1]).toMatchObject({ id: "username", value: "bob" });
    expect(sent[2]).toMatchObject({ id: "password", value: "pw" });
    expect(sent.find((f) => f.id === "usemagnetlinks")).toMatchObject({ value: true });
    expect(sent.find((f) => f.id === "searchbyuploader")).toMatchObject({ value: null });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("rutracker"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the save error inline, explains FlareSolverr and keeps input", async () => {
    vi.spyOn(api, "indexerConfig").mockResolvedValue(structuredClone(rutracker));
    vi.spyOn(api, "saveIndexerConfig").mockRejectedValue(
      new ApiError(500, "Challenge detected but FlareSolverr is not configured"),
    );
    const onOpenChange = vi.fn();
    const user = userEvent.setup();

    wrap(<IndexerConfigDialog indexerId="rutracker" onOpenChange={onOpenChange} />);
    const username = await screen.findByLabelText("Username");
    await user.type(username, "bob");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(await screen.findByText("Не удалось сохранить")).toBeInTheDocument();
    expect(screen.getByText(/Cloudflare/)).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toHaveValue("bob");
    expect(onOpenChange).not.toHaveBeenCalled();
    // Existing indexer: test button present.
    expect(screen.getByRole("button", { name: "Проверить" })).toBeInTheDocument();
  });

  it("asks before closing a dirty form", async () => {
    vi.spyOn(api, "indexerConfig").mockResolvedValue(structuredClone(rutracker));
    const onOpenChange = vi.fn();
    const user = userEvent.setup();

    wrap(<IndexerConfigDialog indexerId="rutracker" onOpenChange={onOpenChange} />);
    await user.type(await screen.findByLabelText("Username"), "x");
    await user.click(screen.getByRole("button", { name: "Отмена" }));
    expect(await screen.findByText("Закрыть без сохранения?")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders unknown field types without crashing", async () => {
    vi.spyOn(api, "indexerConfig").mockResolvedValue([
      { id: "weird", type: "futuretype", name: "Future", value: "abc" } as unknown as ConfigField,
      { id: "rc", type: "recaptcha", name: "Recaptcha", sitekey: "k" },
    ]);
    wrap(<IndexerConfigDialog indexerId="x" onOpenChange={() => undefined} />);
    expect(await screen.findByText("Future")).toBeInTheDocument();
    expect(screen.getByText("abc")).toBeInTheDocument();
    expect(screen.getByText("Нужна Google reCAPTCHA")).toBeInTheDocument();
  });
});
