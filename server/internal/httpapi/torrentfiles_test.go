package httpapi

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/bropines/jackett-ui/server/internal/jackett/jackettfake"
)

func benStr(s string) string { return strconv.Itoa(len(s)) + ":" + s }

// torrentWithFiles builds a v1 multi-file torrent with n files of 10 bytes.
func torrentWithFiles(n int) string {
	var b strings.Builder
	b.WriteString("d8:announce" + benStr("http://t/a") + "4:infod5:filesl")
	for i := 0; i < n; i++ {
		b.WriteString("d6:lengthi10e4:pathl" + benStr("d") + benStr("f"+strconv.Itoa(i)+".bin") + "ee")
	}
	b.WriteString("e4:name" + benStr("Pack") + "12:piece lengthi16384e6:pieces0:ee")
	return b.String()
}

func filesURL(link string) string {
	return "/_ui/api/torrent/files?link=" + url.QueryEscape(link)
}

type torrentFilesBody struct {
	Magnet    bool   `json:"magnet"`
	Name      string `json:"name"`
	InfoHash  string `json:"infoHash"`
	TotalSize int64  `json:"totalSize"`
	Count     int    `json:"count"`
	Truncated bool   `json:"truncated"`
	Files     []struct {
		Path string `json:"path"`
		Size int64  `json:"size"`
	} `json:"files"`
}

func TestTorrentFilesListsFiles(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	h.jackett.DL = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-bittorrent")
		_, _ = w.Write([]byte(torrentWithFiles(3)))
	}

	for _, link := range []string{
		"/dl/rutor/?jackett_apikey=session&path=abc&file=x",
		"http://" + testHost + "/dl/rutor/?jackett_apikey=session&path=abc",
		"HTTPS://UI.TEST/dl/rutor/?path=abc", // no key in the link: added
	} {
		w := h.do("GET", filesURL(link), nil)
		h.expect(w, http.StatusOK)
		got := decode[torrentFilesBody](t, w)
		if got.Magnet || got.Name != "Pack" || got.Count != 3 || got.TotalSize != 30 || len(got.Files) != 3 ||
			got.Files[0].Path != "d/f0.bin" || got.Files[0].Size != 10 || len(got.InfoHash) != 40 || got.Truncated {
			t.Fatalf("%s: %+v", link, got)
		}
		seen, ok := h.jackett.Last("/dl/rutor/")
		if !ok {
			t.Fatal("jackett saw no /dl request")
		}
		q, _ := url.ParseQuery(seen.Query)
		if q.Get("jackett_apikey") != jackettfake.APIKey || q.Get("path") != "abc" || strings.Contains(seen.Query, "session") {
			t.Fatalf("upstream query %q", seen.Query)
		}
		if seen.Header.Get("Cookie") != "" {
			t.Fatal("Jackett cookie sent to /dl")
		}
	}
}

func TestTorrentFilesRejectsForeignLinks(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	before := len(h.jackett.Seen())
	for _, link := range []string{
		"",
		"http://evil.example/dl/rutor/?path=abc",
		"//evil.example/dl/rutor/",
		"ftp://ui.test/dl/x/",
		"file:///dl/x/",
		"http://user@ui.test/dl/x/",
		"/api/v2.0/server/config",
		"/dl/../api/v2.0/server/config",
		"/bh/rutor/",
		"dl/rutor/",
		"/dlx/rutor/",
		"magnet:?xt=urn:btih:abc",
		"/dl/a\\b/",
		jackettfakeURL(h) + "/dl/rutor/",
	} {
		w := h.do("GET", filesURL(link), nil)
		h.expect(w, http.StatusBadRequest)
		if errorCode(w) != "bad_link" {
			t.Fatalf("%q: %s", link, w.Body.String())
		}
	}
	for _, s := range h.jackett.Seen()[before:] {
		if s.Path != "/UI/Dashboard" {
			t.Fatalf("a rejected link reached Jackett: %+v", s)
		}
	}
}

func jackettfakeURL(h *harness) string { return h.jackett.Server.URL }

func TestTorrentFilesNeedsSession(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	anon := h.clone()
	w := anon.do("GET", filesURL("/dl/rutor/?path=a"), nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d %s", w.Code, w.Body.String())
	}
	// API tokens are not accepted on /_ui/api.
	tok := h.newToken("t")
	w = anon.do("GET", filesURL("/dl/rutor/?path=a")+"&apikey="+tok.Token, nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("token: %d", w.Code)
	}
	// A viewer may use it.
	h.createUser("viewer1", "viewer", "viewer-password-1")
	v := h.as("viewer1", "viewer-password-1")
	h.jackett.DL = func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(torrentWithFiles(1))) }
	v.expect(v.do("GET", filesURL("/dl/rutor/?path=a"), nil), http.StatusOK)
	v.expect(v.do("POST", filesURL("/dl/rutor/?path=a"), nil, xhr), http.StatusMethodNotAllowed)
}

func TestTorrentFilesOutcomes(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	link := filesURL("/dl/rutor/?jackett_apikey=session&path=abc")

	// Magnet-only release: Jackett redirects to the magnet.
	h.jackett.DL = func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567", http.StatusFound)
	}
	w := h.do("GET", link, nil)
	h.expect(w, http.StatusOK)
	if got := decode[torrentFilesBody](t, w); !got.Magnet || got.Files != nil {
		t.Fatalf("magnet: %s", w.Body.String())
	}

	// Redirect elsewhere: not followed.
	h.jackett.DL = func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://evil.example/x.torrent", http.StatusFound)
	}
	w = h.do("GET", link, nil)
	h.expect(w, http.StatusBadGateway)
	if errorCode(w) != "fetch_failed" {
		t.Fatal(w.Body.String())
	}

	// Tracker error.
	h.jackett.DL = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"result":"error","error":"boom"}`))
	}
	w = h.do("GET", link, nil)
	h.expect(w, http.StatusBadGateway)
	if errorCode(w) != "fetch_failed" || !strings.Contains(w.Body.String(), "HTTP 500") {
		t.Fatal(w.Body.String())
	}

	// Not a torrent.
	h.jackett.DL = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html>login required</html>"))
	}
	w = h.do("GET", link, nil)
	h.expect(w, http.StatusUnprocessableEntity)
	if errorCode(w) != "not_a_torrent" {
		t.Fatal(w.Body.String())
	}

	// Too large.
	h.jackett.DL = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-bittorrent")
		chunk := []byte(strings.Repeat("x", 1<<20))
		for i := 0; i < 11; i++ {
			if _, err := w.Write(chunk); err != nil {
				return
			}
		}
	}
	w = h.do("GET", link, nil)
	h.expect(w, http.StatusBadGateway)
	if errorCode(w) != "fetch_failed" || !strings.Contains(w.Body.String(), "10 МБ") {
		t.Fatal(w.Body.String())
	}

	// File cap.
	h.jackett.DL = func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(torrentWithFiles(torrentMaxFiles + 7)))
	}
	w = h.do("GET", link, nil)
	h.expect(w, http.StatusOK)
	got := decode[torrentFilesBody](t, w)
	if !got.Truncated || len(got.Files) != torrentMaxFiles || got.Count != torrentMaxFiles+7 || got.TotalSize != int64(10*(torrentMaxFiles+7)) {
		t.Fatalf("cap: truncated=%v files=%d count=%d", got.Truncated, len(got.Files), got.Count)
	}
}
