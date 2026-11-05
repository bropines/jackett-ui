package torrent

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"math/rand"
	"strconv"
	"strings"
	"testing"
)

// ---- a tiny encoder for building test inputs ----

func enc(v any) string {
	switch x := v.(type) {
	case int:
		return "i" + strconv.Itoa(x) + "e"
	case int64:
		return "i" + strconv.FormatInt(x, 10) + "e"
	case string:
		return strconv.Itoa(len(x)) + ":" + x
	case []any:
		var b strings.Builder
		b.WriteString("l")
		for _, e := range x {
			b.WriteString(enc(e))
		}
		return b.String() + "e"
	case [][2]any: // ordered dict
		var b strings.Builder
		b.WriteString("d")
		for _, kv := range x {
			b.WriteString(enc(kv[0].(string)))
			b.WriteString(enc(kv[1]))
		}
		return b.String() + "e"
	}
	panic("enc: unsupported type")
}

type dict = [][2]any

func multiFile() (torrent string, info string) {
	info = enc(dict{
		{"files", []any{
			dict{{"length", 100}, {"path", []any{"dir", "a.mkv"}}},
			dict{{"attr", "p"}, {"length", 7}, {"path", []any{".pad", "7"}}},
			dict{{"length", 23}, {"path", []any{"b.srt"}}, {"path.utf-8", []any{"subs", "б.srt"}}},
		}},
		{"name", "Show"},
		{"piece length", 16384},
		{"pieces", strings.Repeat("x", 20)},
	})
	torrent = "d8:announce14:http://tracker4:info" + info + "e"
	return
}

func TestDecodeBasics(t *testing.T) {
	v, err := Decode([]byte("d1:ai-42e1:bl3:xyzi0eee"), DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := v.Get("a")
	b, _ := v.Get("b")
	if a.Int != -42 || len(b.List) != 2 || string(b.List[0].Str) != "xyz" || string(b.Raw) != "l3:xyzi0ee" {
		t.Fatalf("decoded %+v", v)
	}
	if _, ok := v.Get("missing"); ok {
		t.Fatal("found missing key")
	}
	// Trailing bytes after the top value are tolerated.
	if _, err := Decode([]byte("le\n"), DefaultLimits); err != nil {
		t.Fatal(err)
	}
}

func TestDecodeRejects(t *testing.T) {
	for _, in := range []string{
		"", "i", "ie", "i-e", "i-0e", "i03e", "i1x2e", "i99999999999999999999e", "i123456789012345678901234e",
		"5:abc", "-1:a", "03:abc", ":", "1", "99999999999:x", "l", "li1e", "d", "d1:a", "di1ei2ee", "x",
		"d1:ae", "l" + strings.Repeat("l", 100) + strings.Repeat("e", 101),
	} {
		if _, err := Decode([]byte(in), DefaultLimits); err == nil || !errors.Is(err, ErrSyntax) {
			t.Errorf("Decode(%q) = %v, want syntax error", in, err)
		}
	}
}

func TestDecodeLimits(t *testing.T) {
	deep := strings.Repeat("l", 10) + strings.Repeat("e", 10)
	if _, err := Decode([]byte(deep), Limits{MaxDepth: 5}); err == nil {
		t.Fatal("depth limit not enforced")
	}
	if _, err := Decode([]byte(deep), Limits{MaxDepth: 10}); err != nil {
		t.Fatalf("depth 10: %v", err)
	}
	many := "l" + strings.Repeat("i1e", 100) + "e"
	if _, err := Decode([]byte(many), Limits{MaxValues: 50}); err == nil {
		t.Fatal("value limit not enforced")
	}
}

func TestParseMultiFile(t *testing.T) {
	tor, info := multiFile()
	got, err := Parse([]byte(tor), 0)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha1.Sum([]byte(info))
	if got.InfoHash != hex.EncodeToString(sum[:]) {
		t.Fatalf("info hash %s", got.InfoHash)
	}
	if got.Name != "Show" || got.TotalSize != 123 || got.Count != 2 || got.Truncated {
		t.Fatalf("got %+v", got)
	}
	if len(got.Files) != 2 || got.Files[0] != (File{"dir/a.mkv", 100}) || got.Files[1] != (File{"subs/б.srt", 23}) {
		t.Fatalf("files %+v", got.Files)
	}
}

func TestParseSingleFileAndCap(t *testing.T) {
	tor := enc(dict{{"info", dict{{"length", 5}, {"name", "a\xffb.iso"}, {"pieces", ""}}}})
	got, err := Parse([]byte(tor), 0)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "a�b.iso" || len(got.Files) != 1 || got.Files[0].Size != 5 || got.Files[0].Path != got.Name {
		t.Fatalf("got %+v", got)
	}

	var files []any
	for i := 0; i < 10; i++ {
		files = append(files, dict{{"length", 1}, {"path", []any{"f" + strconv.Itoa(i)}}})
	}
	tor = enc(dict{{"info", dict{{"files", files}, {"name", "x"}}}})
	got, err = Parse([]byte(tor), 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Files) != 3 || !got.Truncated || got.Count != 10 || got.TotalSize != 10 {
		t.Fatalf("cap: %+v", got)
	}
}

func TestParseV2FileTree(t *testing.T) {
	leaf := func(n int) dict { return dict{{"", dict{{"length", n}, {"pieces root", "r"}}}} }
	tor := enc(dict{{"info", dict{
		{"file tree", dict{{"b.txt", leaf(2)}, {"a", dict{{"c.bin", leaf(3)}}}}},
		{"meta version", 2},
		{"name", "v2"},
	}}})
	got, err := Parse([]byte(tor), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Files) != 2 || got.Files[0] != (File{"a/c.bin", 3}) || got.Files[1] != (File{"b.txt", 2}) || got.TotalSize != 5 {
		t.Fatalf("got %+v", got)
	}
}

func TestParseNotTorrent(t *testing.T) {
	for _, in := range []string{"<html>nope</html>", "de", "d4:infoi1ee", "d4:infod4:name1:xee", enc([]any{"info"})} {
		if _, err := Parse([]byte(in), 0); !errors.Is(err, ErrNotTorrent) {
			t.Errorf("Parse(%q) = %v, want ErrNotTorrent", in, err)
		}
	}
}

// TestGarbageNoPanic throws random bytes and mutations of a valid torrent
// at the decoder: it must return (value or error) without panicking.
func TestGarbageNoPanic(t *testing.T) {
	tor, _ := multiFile()
	rng := rand.New(rand.NewSource(1))
	alphabet := []byte("ilde0123456789:-x")
	for i := 0; i < 20000; i++ {
		var in []byte
		switch i % 3 {
		case 0:
			in = make([]byte, rng.Intn(64))
			for j := range in {
				in[j] = alphabet[rng.Intn(len(alphabet))]
			}
		case 1:
			in = []byte(tor)
			for k := rng.Intn(4) + 1; k > 0; k-- {
				in[rng.Intn(len(in))] = byte(rng.Intn(256))
			}
		default:
			in = []byte(tor)[:rng.Intn(len(tor))]
		}
		_, _ = Parse(in, 10)
	}
}

func FuzzParse(f *testing.F) {
	tor, _ := multiFile()
	for _, s := range []string{tor, "le", "d4:infod6:lengthi1e4:name1:xee", "i-1e", "0:", strings.Repeat("l", 70)} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		v, err := Decode(data, DefaultLimits)
		if err == nil && !bytes.HasPrefix(data, v.Raw) {
			t.Fatalf("Raw is not a prefix of the input")
		}
		_, _ = Parse(data, 100)
	})
}
