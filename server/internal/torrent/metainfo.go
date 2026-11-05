package torrent

import (
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"sort"
	"strings"
	"unicode/utf8"
)

// File is one file of a torrent.
type File struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// Info is what the UI shows about a torrent.
type Info struct {
	Name string `json:"name"`
	// InfoHash is the hex SHA-1 of the bencoded info dictionary.
	InfoHash  string `json:"infoHash"`
	TotalSize int64  `json:"totalSize"`
	// Count is the number of files (also when Files is truncated).
	Count     int    `json:"count"`
	Files     []File `json:"files"`
	Truncated bool   `json:"truncated,omitempty"`
}

// ErrNotTorrent: the data is not a .torrent (bad bencode or no info dict).
var ErrNotTorrent = errors.New("not a torrent")

// Parse reads a .torrent file. At most maxFiles files are listed (0 = no
// cap); TotalSize and Count always cover all files. BEP 47 padding files
// are skipped.
func Parse(data []byte, maxFiles int) (*Info, error) {
	root, err := Decode(data, DefaultLimits)
	if err != nil {
		return nil, errors.Join(ErrNotTorrent, err)
	}
	info, ok := root.Get("info")
	if !ok || info.Kind != KindDict {
		return nil, errors.Join(ErrNotTorrent, errors.New("no info dictionary"))
	}
	sum := sha1.Sum(info.Raw)
	out := &Info{InfoHash: hex.EncodeToString(sum[:]), Files: []File{}}
	out.Name = text(info, "name")

	add := func(path string, size int64) {
		if size < 0 {
			size = 0
		}
		out.Count++
		if out.TotalSize > (1<<63-1)-size {
			out.TotalSize = 1<<63 - 1
		} else {
			out.TotalSize += size
		}
		if maxFiles > 0 && len(out.Files) >= maxFiles {
			out.Truncated = true
			return
		}
		out.Files = append(out.Files, File{Path: path, Size: size})
	}

	switch files, ok := info.Get("files"); {
	case ok && files.Kind == KindList:
		// v1 multi-file.
		for i := range files.List {
			f := &files.List[i]
			if f.Kind != KindDict {
				continue
			}
			if attr, ok := f.Get("attr"); ok && attr.Kind == KindString && strings.ContainsRune(string(attr.Str), 'p') {
				continue
			}
			p := pathList(f)
			if strings.HasPrefix(p, ".pad/") {
				continue
			}
			add(p, intOf(f, "length"))
		}
	default:
		if l, ok := info.Get("length"); ok && l.Kind == KindInt {
			// v1 single file.
			add(out.Name, l.Int)
		} else if tree, ok := info.Get("file tree"); ok && tree.Kind == KindDict {
			// v2-only torrent (BEP 52).
			walkTree(tree, nil, add)
		} else {
			return nil, errors.Join(ErrNotTorrent, errors.New("no files in info dictionary"))
		}
	}
	return out, nil
}

// walkTree visits a BEP 52 file tree: a file is a dict whose "" member
// holds {length, pieces root}. Children are visited in key order.
func walkTree(dir *Value, prefix []string, add func(string, int64)) {
	ents := append([]Entry(nil), dir.Dict...)
	sort.SliceStable(ents, func(i, j int) bool { return ents[i].Key < ents[j].Key })
	for i := range ents {
		e := &ents[i]
		if e.Value.Kind != KindDict {
			continue
		}
		if e.Key == "" {
			if len(prefix) > 0 {
				add(strings.Join(prefix, "/"), intOf(&e.Value, "length"))
			}
			continue
		}
		walkTree(&e.Value, append(prefix[:len(prefix):len(prefix)], clean(e.Key)), add)
	}
}

// text returns key.utf-8 or key as valid UTF-8.
func text(d *Value, key string) string {
	if v, ok := d.Get(key + ".utf-8"); ok && v.Kind == KindString {
		return clean(string(v.Str))
	}
	if v, ok := d.Get(key); ok && v.Kind == KindString {
		return clean(string(v.Str))
	}
	return ""
}

// pathList joins path.utf-8 (or path) components with "/".
func pathList(f *Value) string {
	for _, k := range []string{"path.utf-8", "path"} {
		v, ok := f.Get(k)
		if !ok || v.Kind != KindList || len(v.List) == 0 {
			continue
		}
		parts := make([]string, 0, len(v.List))
		for i := range v.List {
			if v.List[i].Kind == KindString {
				parts = append(parts, clean(string(v.List[i].Str)))
			}
		}
		return strings.Join(parts, "/")
	}
	return ""
}

func intOf(d *Value, key string) int64 {
	if v, ok := d.Get(key); ok && v.Kind == KindInt {
		return v.Int
	}
	return 0
}

func clean(s string) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	return s
}
