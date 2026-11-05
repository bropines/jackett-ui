import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { serverApi, type SearchResponse, type SearchResult } from "@/api";
import { TooltipProvider } from "@/components/ui/misc";

import { toRows } from "../logic";
import { ResultsView } from "../ResultsView";

const fixture = JSON.parse(readFileSync(join(process.cwd(), "contract/results-all.json"), "utf8")) as SearchResponse;
const base = fixture.Results[0]!;

function renderOne(r: SearchResult) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ResultsView rows={toRows([r])} only={null} onOnly={() => undefined} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("ResultPreview", () => {
  it("opens from the title, shows details and the file list, closes on Esc", async () => {
    const spy = vi.spyOn(serverApi, "torrentFiles").mockResolvedValue({
      name: "Pack",
      infoHash: "a".repeat(40),
      totalSize: 3 * 1024 * 1024,
      count: 2,
      files: [
        { path: "Pack/disc/a.iso", size: 2 * 1024 * 1024 },
        { path: "Pack/readme.txt", size: 1024 * 1024 },
      ],
    });
    const r: SearchResult = { ...base, TrackerType: "public", Poster: "https://img.example/p.jpg", Imdb: 133093, Description: "Line one\nLine 2 & more" };
    renderOne(r);
    expect(screen.getByRole("listitem").querySelector("img")).toHaveAttribute("loading", "lazy");

    fireEvent.click(screen.getByRole("button", { name: r.Title }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: r.Title })).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /IMDb/ })).toHaveAttribute("href", "https://www.imdb.com/title/tt0133093/");
    expect(within(dialog).getByRole("link", { name: /Скачать \.torrent/ })).toBeInTheDocument();
    expect(within(dialog).getByText(/Line 2 & more/)).toBeInTheDocument();

    await within(dialog).findByText("a.iso");
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^\/dl\/rutor\/\?/));
    // The single top folder (torrent name) is unwrapped; small torrents start expanded.
    expect(within(dialog).getByText("disc")).toBeInTheDocument();
    expect(within(dialog).getByText("readme.txt")).toBeInTheDocument();
    expect(within(dialog).getByText(/2 файла/)).toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("says when only a magnet exists, without calling the server", async () => {
    const spy = vi.spyOn(serverApi, "torrentFiles");
    renderOne({ ...base, Link: null });
    fireEvent.click(screen.getByRole("button", { name: "Подробнее" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/только magnet-ссылка/)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("waits for a click on private trackers and shows server errors", async () => {
    const { ApiError } = await import("@/api");
    const spy = vi.spyOn(serverApi, "torrentFiles").mockRejectedValue(new ApiError(422, "Трекер вернул не .torrent-файл"));
    renderOne({ ...base, TrackerType: "private" });
    fireEvent.click(screen.getByRole("button", { name: base.Title }));
    const dialog = await screen.findByRole("dialog");
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: /Показать файлы/ }));
    expect(await within(dialog).findByText("Трекер вернул не .torrent-файл")).toBeInTheDocument();
  });

  it("reports magnet redirects from the server", async () => {
    vi.spyOn(serverApi, "torrentFiles").mockResolvedValue({ magnet: true });
    renderOne({ ...base, TrackerType: "public" });
    fireEvent.click(screen.getByRole("button", { name: base.Title }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/только magnet-ссылка/)).toBeInTheDocument();
  });
});
