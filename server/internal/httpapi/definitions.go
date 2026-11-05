package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/bropines/jackett-ui/server/internal/store"
)

// Own trackers: Cardigann YAML definitions in Jackett's custom definitions
// folder (CARDIGANN_DIR, shared with the Jackett container). Jackett reads
// them at start-up; "reload" makes it restart its web host, which loads the
// definitions again (see docs/spec-v0.4-auth.md, "Own trackers").

const (
	maxDefinitionSize = 256 << 10
	maxDefinitions    = 500
)

var definitionIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

type definitionView struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	File       string    `json:"file"`
	Size       int64     `json:"size"`
	ModifiedAt time.Time `json:"modifiedAt"`
	// Problem: the file doesn't look like a definition this panel can manage.
	Problem string `json:"problem,omitempty"`
}

type definitionsResponse struct {
	Available bool             `json:"available"`
	Dir       string           `json:"dir"`
	Reason    string           `json:"reason,omitempty"`
	Items     []definitionView `json:"items"`
}

var errDefinitionsOff = &apiError{Status: http.StatusConflict, Code: "definitions_unavailable",
	Message: "Папка своих трекеров не подключена: задайте CARDIGANN_DIR (папка cardigann/definitions Jackett)"}

// definitionsDir returns the folder, or why it can't be used.
func (s *Server) definitionsDir() (string, string) {
	dir := s.env.CardigannDir
	if dir == "" {
		return "", errDefinitionsOff.Message
	}
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		if errors.Is(err, fs.ErrNotExist) {
			// Create it: Jackett only reads it, so an empty folder is harmless.
			if os.MkdirAll(dir, 0o755) == nil {
				return dir, ""
			}
		}
		return "", "Папка " + dir + " недоступна"
	}
	return dir, ""
}

// yamlTop reads top-level "key: value" pairs (id, name) from a definition
// without a YAML library: enough to list and validate files.
func yamlTop(r io.Reader, keys ...string) map[string]string {
	want := map[string]bool{}
	for _, k := range keys {
		want[k] = true
	}
	out := map[string]string{}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), maxDefinitionSize)
	for sc.Scan() && len(out) < len(want) {
		line := sc.Text()
		if line == "" || line[0] == ' ' || line[0] == '\t' || line[0] == '#' || line == "---" {
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok || !want[k] {
			continue
		}
		if _, seen := out[k]; seen {
			continue
		}
		v = strings.TrimSpace(v)
		if i := strings.Index(v, " #"); i >= 0 {
			v = strings.TrimSpace(v[:i])
		}
		v = strings.Trim(v, `"'`)
		out[k] = v
	}
	return out
}

func readDefinition(dir, file string) definitionView {
	p := filepath.Join(dir, file)
	v := definitionView{File: file, ID: strings.TrimSuffix(file, filepath.Ext(file))}
	fi, err := os.Stat(p)
	if err != nil {
		v.Problem = "не читается"
		return v
	}
	v.Size, v.ModifiedAt = fi.Size(), fi.ModTime().UTC()
	f, err := os.Open(p)
	if err != nil {
		v.Problem = "не читается"
		return v
	}
	defer f.Close()
	top := yamlTop(io.LimitReader(f, maxDefinitionSize), "id", "name")
	v.Name = top["name"]
	switch {
	case top["id"] == "":
		v.Problem = "нет поля id"
	case top["id"] != v.ID:
		v.Problem = "id в файле (" + top["id"] + ") не совпадает с именем файла"
	}
	return v
}

func (s *Server) handleDefinitionsList(w http.ResponseWriter) {
	dir, reason := s.definitionsDir()
	resp := definitionsResponse{Available: reason == "", Dir: s.env.CardigannDir, Reason: reason, Items: []definitionView{}}
	if reason == "" {
		entries, err := os.ReadDir(dir)
		if err != nil {
			resp.Available, resp.Reason = false, "Папка "+dir+" не читается"
		}
		for _, e := range entries {
			ext := strings.ToLower(filepath.Ext(e.Name()))
			if e.IsDir() || (ext != ".yml" && ext != ".yaml") || strings.HasPrefix(e.Name(), ".") {
				continue
			}
			resp.Items = append(resp.Items, readDefinition(dir, e.Name()))
			if len(resp.Items) >= maxDefinitions {
				break
			}
		}
		sort.Slice(resp.Items, func(i, j int) bool { return resp.Items[i].ID < resp.Items[j].ID })
	}
	writeJSON(w, http.StatusOK, resp)
}

func definitionIDArg(id string) error {
	if !definitionIDRe.MatchString(id) {
		return badField("id", "id: латиница в нижнем регистре, цифры, точка, _ и -, до 64 символов")
	}
	return nil
}

// definitionFile finds the file for id (.yml or .yaml), "" if none.
func definitionFile(dir, id string) string {
	for _, ext := range []string{".yml", ".yaml"} {
		if fi, err := os.Stat(filepath.Join(dir, id+ext)); err == nil && fi.Mode().IsRegular() {
			return id + ext
		}
	}
	return ""
}

var errDefinitionNotFound = &apiError{Status: http.StatusNotFound, Code: "definition_not_found", Message: "Такого файла нет"}

func (s *Server) handleDefinitionGet(w http.ResponseWriter, id string) {
	dir, reason := s.definitionsDir()
	if reason != "" {
		writeAPIError(w, errDefinitionsOff)
		return
	}
	if err := definitionIDArg(id); err != nil {
		writeAPIError(w, err)
		return
	}
	file := definitionFile(dir, id)
	if file == "" {
		writeAPIError(w, errDefinitionNotFound)
		return
	}
	data, err := os.ReadFile(filepath.Join(dir, file))
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if len(data) > maxDefinitionSize {
		data = data[:maxDefinitionSize]
	}
	writeJSON(w, http.StatusOK, map[string]any{"definition": readDefinition(dir, file), "content": string(data)})
}

func (s *Server) handleDefinitionPut(w http.ResponseWriter, r *http.Request, pr *principal, id string) {
	dir, reason := s.definitionsDir()
	if reason != "" {
		writeAPIError(w, errDefinitionsOff)
		return
	}
	if err := definitionIDArg(id); err != nil {
		writeAPIError(w, err)
		return
	}
	var body struct {
		Content string `json:"content"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxDefinitionSize+4096)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeAPIError(w, &apiError{Status: http.StatusBadRequest, Code: "bad_request", Message: "Файл больше 256 КБ или некорректный запрос"})
		return
	}
	content := strings.ReplaceAll(body.Content, "\r\n", "\n")
	if len(content) > maxDefinitionSize {
		writeAPIError(w, badField("content", "Файл больше 256 КБ"))
		return
	}
	top := yamlTop(strings.NewReader(content), "id", "name", "links")
	switch {
	case top["id"] == "":
		writeAPIError(w, badField("content", "В файле нет строки id: на верхнем уровне"))
		return
	case top["id"] != id:
		writeAPIError(w, badField("content", "id в файле ("+top["id"]+") должен совпадать с именем ("+id+")"))
		return
	case top["name"] == "":
		writeAPIError(w, badField("content", "В файле нет строки name: на верхнем уровне"))
		return
	}
	if _, ok := top["links"]; !ok {
		writeAPIError(w, badField("content", "В файле нет раздела links: (адреса трекера)"))
		return
	}
	file := definitionFile(dir, id)
	if file == "" {
		file = id + ".yml"
	}
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	// 0644: the Jackett container (another uid) must be able to read it.
	if err := writeFileAtomicMode(filepath.Join(dir, file), []byte(content), 0o644); err != nil {
		writeAPIError(w, err)
		return
	}
	s.log.Warn("own tracker definition saved", "id", id, "by", pr.name())
	writeJSON(w, http.StatusOK, readDefinition(dir, file))
}

func (s *Server) handleDefinitionDelete(w http.ResponseWriter, pr *principal, id string) {
	dir, reason := s.definitionsDir()
	if reason != "" {
		writeAPIError(w, errDefinitionsOff)
		return
	}
	if err := definitionIDArg(id); err != nil {
		writeAPIError(w, err)
		return
	}
	file := definitionFile(dir, id)
	if file == "" {
		writeAPIError(w, errDefinitionNotFound)
		return
	}
	if err := os.Remove(filepath.Join(dir, file)); err != nil {
		writeAPIError(w, err)
		return
	}
	s.log.Warn("own tracker definition deleted", "id", id, "by", pr.name())
	w.WriteHeader(http.StatusNoContent)
}

// handleDefinitionsReload makes Jackett load its definitions again: any
// change of the FlareSolverr timeout restarts Jackett's web host, which
// re-reads the definitions folders. The timeout alternates by 1 ms.
func (s *Server) handleDefinitionsReload(w http.ResponseWriter, r *http.Request, pr *principal) {
	if s.jc == nil {
		writeAPIError(w, errJackettDown)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	cfg, err := s.jackettJSON(ctx, http.MethodGet, "/api/v2.0/server/config", nil)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	t, _ := cfg["flaresolverr_maxtimeout"].(float64)
	if t <= 0 {
		t = 55000
	}
	if int64(t)%2 == 0 {
		t++
	} else {
		t--
	}
	cfg["flaresolverr_maxtimeout"] = t
	body, _ := json.Marshal(cfg)
	since := time.Now().UTC()
	if _, err := s.jackettJSON(ctx, http.MethodPost, "/api/v2.0/server/config", body); err != nil {
		writeAPIError(w, err)
		return
	}
	s.jc.InvalidateAPIKey()
	// Wait until Jackett answers again (the web host restarts in a few seconds).
	time.Sleep(1500 * time.Millisecond)
	ok := false
	for i := 0; i < 40 && ctx.Err() == nil; i++ {
		if _, err := s.jackettJSON(ctx, http.MethodGet, "/api/v2.0/server/config", nil); err == nil {
			ok = true
			break
		}
		time.Sleep(time.Second)
	}
	s.log.Warn("jackett definitions reloaded", "by", pr.name(), "ok", ok)
	writeJSON(w, http.StatusOK, map[string]any{"ok": ok, "messages": s.definitionMessages(ctx, since)})
}

// definitionMessages returns Jackett log lines about definitions written
// after since (parse errors show up there).
func (s *Server) definitionMessages(ctx context.Context, since time.Time) []string {
	resp, err := s.jc.Do(ctx, http.MethodGet, "/api/v2.0/server/logs", nil)
	if err != nil {
		return []string{}
	}
	defer resp.Body.Close()
	var logs []struct {
		When    time.Time `json:"when"`
		Level   string    `json:"level"`
		Message string    `json:"message"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&logs) != nil {
		return []string{}
	}
	out := []string{}
	for _, l := range logs {
		m := strings.ToLower(l.Message)
		if l.When.Before(since.Add(-2*time.Second)) || !(strings.Contains(m, "cardigann") || strings.Contains(m, "definition") || strings.Contains(m, ".yml")) {
			continue
		}
		msg := l.Message
		if len(msg) > 2000 {
			msg = msg[:2000] + "…"
		}
		out = append(out, l.Level+": "+msg)
		if len(out) >= 50 {
			break
		}
	}
	return out
}

var errJackettDown = &apiError{Status: http.StatusBadGateway, Code: "jackett_unreachable", Message: "Jackett недоступен"}

// jackettJSON does an API call to Jackett and decodes a JSON object answer
// (an empty body gives an empty map).
func (s *Server) jackettJSON(ctx context.Context, method, path string, body []byte) (map[string]any, error) {
	resp, err := s.jc.Do(ctx, method, path, body)
	if err != nil {
		return nil, errJackettDown
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		msg := "Jackett ответил " + resp.Status
		if e.Error != "" {
			msg = "Jackett: " + e.Error
		}
		return nil, &apiError{Status: http.StatusBadGateway, Code: "jackett_error", Message: msg}
	}
	out := map[string]any{}
	if len(strings.TrimSpace(string(data))) > 0 {
		if err := json.Unmarshal(data, &out); err != nil {
			return nil, &apiError{Status: http.StatusBadGateway, Code: "jackett_error", Message: "Jackett вернул не JSON"}
		}
	}
	return out, nil
}

// writeFileAtomicMode is store.WriteFileAtomic with a chosen mode.
func writeFileAtomicMode(path string, data []byte, mode os.FileMode) error {
	if err := store.WriteFileAtomic(path, data); err != nil {
		return err
	}
	return os.Chmod(path, mode)
}
