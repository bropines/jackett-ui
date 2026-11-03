package httpapi

import (
	"bytes"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"
)

// staticHandler serves the built UI with an SPA fallback:
//   - existing files are served; /assets/* get a one-year immutable cache,
//     everything else (index.html included) "no-cache";
//   - a missing /assets/* file is 404 (no HTML for a missing script);
//   - any other path gets index.html (client-side routes).
type staticHandler struct {
	fsys fs.FS
}

func newStatic(fsys fs.FS) *staticHandler { return &staticHandler{fsys: fsys} }

const (
	cacheImmutable = "public, max-age=31536000, immutable"
	cacheNoCache   = "no-cache"
)

func (h *staticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request, p string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, "GET, HEAD")
		return
	}
	if h.fsys == nil {
		writeErr(w, http.StatusNotFound, "not_found", "Не найдено")
		return
	}
	name := strings.TrimPrefix(p, "/")
	isAsset := strings.HasPrefix(p, "/assets/")
	if name != "" && !strings.HasSuffix(name, "/") && fs.ValidPath(name) && !hiddenPath(name) {
		if h.serveFile(w, r, name, isAsset) {
			return
		}
	}
	if isAsset {
		writeErr(w, http.StatusNotFound, "not_found", "Не найдено")
		return
	}
	if !h.serveFile(w, r, "index.html", false) {
		writeErr(w, http.StatusNotFound, "not_found", "UI не собран (нет index.html)")
	}
}

func hiddenPath(name string) bool {
	for _, part := range strings.Split(name, "/") {
		if strings.HasPrefix(part, ".") {
			return true
		}
	}
	return false
}

// serveFile serves name if it is a regular file; false if it doesn't exist.
func (h *staticHandler) serveFile(w http.ResponseWriter, r *http.Request, name string, immutable bool) bool {
	f, err := h.fsys.Open(name)
	if err != nil {
		return false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.IsDir() || !fi.Mode().IsRegular() {
		return false
	}
	if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if immutable {
		w.Header().Set("Cache-Control", cacheImmutable)
	} else {
		w.Header().Set("Cache-Control", cacheNoCache)
	}
	var content io.ReadSeeker
	if rs, ok := f.(io.ReadSeeker); ok {
		content = rs
	} else {
		b, err := io.ReadAll(f)
		if err != nil {
			return false
		}
		content = bytes.NewReader(b)
	}
	modTime := fi.ModTime()
	if modTime.IsZero() || modTime.Equal(time.Unix(0, 0)) {
		modTime = time.Time{}
	}
	http.ServeContent(w, r, name, modTime, content)
	return true
}
