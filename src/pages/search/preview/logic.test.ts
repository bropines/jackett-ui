import { buildTree, descriptionHtml, filesLink, imdbUrl, isFlat, posterUrl, tmdbUrl } from "./logic";

describe("preview logic", () => {
  it("accepts only http(s) posters", () => {
    expect(posterUrl("https://img.example/p.jpg")).toBe("https://img.example/p.jpg");
    expect(posterUrl("javascript:alert(1)")).toBeNull();
    expect(posterUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(posterUrl(null)).toBeNull();
  });

  it("turns result links into same-origin /dl paths", () => {
    const link = "http://127.0.0.1:9117/dl/rutor/?jackett_apikey=session&path=abc&file=x";
    expect(filesLink(link)).toBe("/dl/rutor/?jackett_apikey=session&path=abc&file=x");
    expect(filesLink("https://tracker.example/download/1")).toBeNull();
    expect(filesLink(null)).toBeNull();
  });

  it("builds IMDb / TMDb links", () => {
    expect(imdbUrl(133093)).toBe("https://www.imdb.com/title/tt0133093/");
    expect(imdbUrl(0)).toBeNull();
    expect(tmdbUrl(603, [2000, 2040])).toBe("https://www.themoviedb.org/movie/603");
    expect(tmdbUrl(1399, [5040])).toBe("https://www.themoviedb.org/tv/1399");
    expect(tmdbUrl(null)).toBeNull();
  });

  it("prepares descriptions", () => {
    expect(descriptionHtml("Same  title", "Same title")).toBeNull();
    expect(descriptionHtml("  ")).toBeNull();
    expect(descriptionHtml("a < b & c\nnext")).toBe("a &lt; b &amp; c<br>next");
    expect(descriptionHtml("<b>x</b>\ny")).toBe("<b>x</b><br>y");
    expect(descriptionHtml("<p>x</p>\n<p>y</p>")).toBe("<p>x</p>\n<p>y</p>");
    expect(descriptionHtml("<p>Hi <b>there</b></p>")).toBe("<p>Hi <b>there</b></p>");
  });

  it("builds a sorted tree with folder totals", () => {
    const tree = buildTree([
      { path: "Show/S01/e10.mkv", size: 10 },
      { path: "Show/S01/e2.mkv", size: 20 },
      { path: "Show/readme.txt", size: 1 },
      { path: "Show/Extras/x.mkv", size: 5 },
    ]);
    expect(tree.size).toBe(36);
    expect(tree.count).toBe(4);
    const show = tree.children[0]!;
    expect(show.kind === "dir" && show.count).toBe(4);
    if (show.kind !== "dir") throw new Error("dir expected");
    expect(show.children.map((c) => c.name)).toEqual(["Extras", "S01", "readme.txt"]);
    const s01 = show.children[1]!;
    if (s01.kind !== "dir") throw new Error("dir expected");
    expect(s01.size).toBe(30);
    expect(s01.children.map((c) => c.name)).toEqual(["e2.mkv", "e10.mkv"]);
    expect(isFlat(tree)).toBe(false);
    expect(isFlat(buildTree([{ path: "a.iso", size: 1 }]))).toBe(true);
  });
});
