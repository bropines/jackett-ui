package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleDefinition = `---
id: mytracker
name: My Tracker # comment
description: test
language: ru-RU
type: public
encoding: UTF-8
links:
  - https://example.org/
search:
  paths:
    - path: /search
`

func TestDefinitions(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cardigann", "definitions")
	h := newHarness(t, harnessOpt{env: map[string]string{"CARDIGANN_DIR": dir}})
	h.setup()

	list := decode[definitionsResponse](t, h.do("GET", "/_ui/api/definitions", nil))
	if !list.Available || len(list.Items) != 0 {
		t.Fatalf("empty list: %+v", list)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatal("folder not created")
	}

	bad := []struct {
		id, content, want string
	}{
		{"Bad ID", sampleDefinition, "invalid_value"},
		{"other", sampleDefinition, "invalid_value"},                                                             // id mismatch
		{"mytracker", strings.Replace(sampleDefinition, "name: My Tracker # comment\n", "", 1), "invalid_value"}, // no name
		{"mytracker", strings.Replace(sampleDefinition, "links:", "linkz:", 1), "invalid_value"},
		{"mytracker", strings.Repeat("x", maxDefinitionSize+10), "invalid_value"},
		{"mytracker", strings.Repeat("x", maxDefinitionSize+10000), "bad_request"},
	}
	for _, c := range bad {
		if w := h.do("PUT", "/_ui/api/definitions/"+strings.ReplaceAll(c.id, " ", "%20"), map[string]any{"content": c.content}); errorCode(w) != c.want {
			t.Fatalf("%s: %d %s", c.id, w.Code, w.Body.String())
		}
	}

	w := h.do("PUT", "/_ui/api/definitions/mytracker", map[string]any{"content": strings.ReplaceAll(sampleDefinition, "\n", "\r\n")})
	h.expect(w, http.StatusOK)
	v := decode[definitionView](t, w)
	if v.ID != "mytracker" || v.Name != "My Tracker" || v.File != "mytracker.yml" || v.Problem != "" {
		t.Fatalf("saved: %+v", v)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "mytracker.yml"))
	if strings.Contains(string(raw), "\r") {
		t.Fatal("CRLF kept")
	}
	if fi, _ := os.Stat(filepath.Join(dir, "mytracker.yml")); fi.Mode().Perm() != 0o644 {
		t.Fatalf("mode %v", fi.Mode().Perm())
	}
	// A foreign file shows up with a problem.
	_ = os.WriteFile(filepath.Join(dir, "broken.yaml"), []byte("name: x\n"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0o644)
	list = decode[definitionsResponse](t, h.do("GET", "/_ui/api/definitions", nil))
	if len(list.Items) != 2 || list.Items[0].ID != "broken" || list.Items[0].Problem == "" || list.Items[1].ID != "mytracker" {
		t.Fatalf("list: %+v", list.Items)
	}

	var got struct {
		Content string `json:"content"`
	}
	_ = json.Unmarshal(h.do("GET", "/_ui/api/definitions/mytracker", nil).Body.Bytes(), &got)
	if got.Content != sampleDefinition {
		t.Fatalf("content: %q", got.Content)
	}

	// Viewers and editors can't touch definitions.
	h.createUser("ed", "editor", "editor-password")
	ed := h.as("ed", "editor-password")
	if w := ed.do("GET", "/_ui/api/definitions", nil); w.Code != http.StatusForbidden {
		t.Fatalf("editor: %d", w.Code)
	}

	// Reload: one config round trip with the FlareSolverr timeout nudged.
	w = h.do("POST", "/_ui/api/definitions/reload", map[string]any{})
	h.expect(w, http.StatusOK)
	foundPost := false
	for _, s := range h.jackett.Seen() {
		if s.Path == "/api/v2.0/server/config" && s.Method == http.MethodPost && strings.Contains(s.Body, `"flaresolverr_maxtimeout":55001`) {
			foundPost = true
		}
	}
	if !foundPost {
		t.Fatal("no config POST with a nudged timeout")
	}

	h.expect(h.do("DELETE", "/_ui/api/definitions/mytracker", nil, xhr), http.StatusNoContent)
	if w := h.do("DELETE", "/_ui/api/definitions/mytracker", nil, xhr); errorCode(w) != "definition_not_found" {
		t.Fatalf("delete twice: %d", w.Code)
	}

	// Without CARDIGANN_DIR the editor is off.
	off := newHarness(t, harnessOpt{})
	off.setup()
	l := decode[definitionsResponse](t, off.do("GET", "/_ui/api/definitions", nil))
	if l.Available || l.Reason == "" {
		t.Fatalf("off: %+v", l)
	}
	if w := off.do("PUT", "/_ui/api/definitions/mytracker", map[string]any{"content": sampleDefinition}); errorCode(w) != "definitions_unavailable" {
		t.Fatalf("off put: %d", w.Code)
	}
}

func TestYamlTop(t *testing.T) {
	m := yamlTop(strings.NewReader("# c\n---\nid: 'abc'\n  name: nested\nname: \"Abc Tracker\" # x\nlinks:\n  - a\nid: again\n"), "id", "name", "links")
	if m["id"] != "abc" || m["name"] != "Abc Tracker" || m["links"] != "" {
		t.Fatalf("%+v", m)
	}
	if _, ok := m["links"]; !ok {
		t.Fatal("links key missing")
	}
}
