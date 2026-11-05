// Package torrent decodes bencoded .torrent files: a small, strict-enough
// bencode decoder with depth and size limits, and a metainfo reader that
// lists the files and computes the info hash.
package torrent

import (
	"errors"
	"fmt"
	"strconv"
)

// Kind is the type of a bencoded value.
type Kind uint8

// Value kinds.
const (
	KindInt Kind = iota + 1
	KindString
	KindList
	KindDict
)

// Value is a decoded bencode value. Str and Raw alias the input buffer.
type Value struct {
	Kind Kind
	Int  int64
	Str  []byte
	List []Value
	Dict []Entry
	// Raw is the exact encoded form of the value inside the input.
	Raw []byte
}

// Entry is one dictionary member (input order kept).
type Entry struct {
	Key   string
	Value Value
}

// Get returns the first member named key of a dictionary.
func (v *Value) Get(key string) (*Value, bool) {
	if v == nil || v.Kind != KindDict {
		return nil, false
	}
	for i := range v.Dict {
		if v.Dict[i].Key == key {
			return &v.Dict[i].Value, true
		}
	}
	return nil, false
}

// Limits bound the decoder's work.
type Limits struct {
	// MaxDepth is the maximum nesting of lists and dicts.
	MaxDepth int
	// MaxValues is the maximum number of values in the document.
	MaxValues int
}

// DefaultLimits suit .torrent files up to a few MB.
var DefaultLimits = Limits{MaxDepth: 64, MaxValues: 2_000_000}

// ErrSyntax wraps every decoding error.
var ErrSyntax = errors.New("bencode: syntax error")

// Decode parses one value at the start of data. Trailing bytes after it are
// ignored (some .torrent files carry a newline or padding).
func Decode(data []byte, lim Limits) (Value, error) {
	if lim.MaxDepth <= 0 {
		lim.MaxDepth = DefaultLimits.MaxDepth
	}
	if lim.MaxValues <= 0 {
		lim.MaxValues = DefaultLimits.MaxValues
	}
	d := decoder{buf: data, lim: lim}
	v, err := d.value(0)
	if err != nil {
		return Value{}, err
	}
	return v, nil
}

type decoder struct {
	buf    []byte
	pos    int
	lim    Limits
	values int
}

func (d *decoder) fail(msg string) error {
	return fmt.Errorf("%w at offset %d: %s", ErrSyntax, d.pos, msg)
}

func (d *decoder) value(depth int) (Value, error) {
	if d.pos >= len(d.buf) {
		return Value{}, d.fail("unexpected end of data")
	}
	d.values++
	if d.values > d.lim.MaxValues {
		return Value{}, d.fail("too many values")
	}
	start := d.pos
	switch c := d.buf[d.pos]; {
	case c == 'i':
		n, err := d.integer()
		if err != nil {
			return Value{}, err
		}
		return Value{Kind: KindInt, Int: n, Raw: d.buf[start:d.pos]}, nil
	case c >= '0' && c <= '9':
		s, err := d.str()
		if err != nil {
			return Value{}, err
		}
		return Value{Kind: KindString, Str: s, Raw: d.buf[start:d.pos]}, nil
	case c == 'l':
		if depth >= d.lim.MaxDepth {
			return Value{}, d.fail("nesting too deep")
		}
		d.pos++
		var list []Value
		for {
			if d.pos >= len(d.buf) {
				return Value{}, d.fail("unterminated list")
			}
			if d.buf[d.pos] == 'e' {
				d.pos++
				break
			}
			v, err := d.value(depth + 1)
			if err != nil {
				return Value{}, err
			}
			list = append(list, v)
		}
		return Value{Kind: KindList, List: list, Raw: d.buf[start:d.pos]}, nil
	case c == 'd':
		if depth >= d.lim.MaxDepth {
			return Value{}, d.fail("nesting too deep")
		}
		d.pos++
		var dict []Entry
		for {
			if d.pos >= len(d.buf) {
				return Value{}, d.fail("unterminated dictionary")
			}
			if d.buf[d.pos] == 'e' {
				d.pos++
				break
			}
			if c := d.buf[d.pos]; c < '0' || c > '9' {
				return Value{}, d.fail("dictionary key is not a string")
			}
			k, err := d.str()
			if err != nil {
				return Value{}, err
			}
			v, err := d.value(depth + 1)
			if err != nil {
				return Value{}, err
			}
			dict = append(dict, Entry{Key: string(k), Value: v})
		}
		return Value{Kind: KindDict, Dict: dict, Raw: d.buf[start:d.pos]}, nil
	default:
		return Value{}, d.fail("unexpected byte " + strconv.QuoteRune(rune(c)))
	}
}

// integer reads i<digits>e (no leading zeros, no -0).
func (d *decoder) integer() (int64, error) {
	d.pos++ // 'i'
	start := d.pos
	for d.pos < len(d.buf) && d.buf[d.pos] != 'e' {
		if d.pos-start > 20 {
			return 0, d.fail("integer too long")
		}
		d.pos++
	}
	if d.pos >= len(d.buf) {
		return 0, d.fail("unterminated integer")
	}
	digits := string(d.buf[start:d.pos])
	d.pos++ // 'e'
	body := digits
	if len(body) > 0 && body[0] == '-' {
		body = body[1:]
	}
	if body == "" {
		return 0, d.fail("empty integer")
	}
	for i := 0; i < len(body); i++ {
		if body[i] < '0' || body[i] > '9' {
			return 0, d.fail("bad integer")
		}
	}
	if (len(body) > 1 && body[0] == '0') || digits == "-0" {
		return 0, d.fail("non-canonical integer")
	}
	n, err := strconv.ParseInt(digits, 10, 64)
	if err != nil {
		return 0, d.fail("integer out of range")
	}
	return n, nil
}

// str reads <len>:<bytes>.
func (d *decoder) str() ([]byte, error) {
	var n int64
	start := d.pos
	for d.pos < len(d.buf) && d.buf[d.pos] != ':' {
		c := d.buf[d.pos]
		if c < '0' || c > '9' {
			return nil, d.fail("bad string length")
		}
		if d.pos-start >= 10 { // > 9 999 999 999 bytes: never fits
			return nil, d.fail("string length too large")
		}
		n = n*10 + int64(c-'0')
		d.pos++
	}
	if d.pos >= len(d.buf) {
		return nil, d.fail("unterminated string length")
	}
	if d.pos == start {
		return nil, d.fail("empty string length")
	}
	if d.pos-start > 1 && d.buf[start] == '0' {
		return nil, d.fail("non-canonical string length")
	}
	d.pos++ // ':'
	if n > int64(len(d.buf)-d.pos) {
		return nil, d.fail("string exceeds data")
	}
	s := d.buf[d.pos : d.pos+int(n)]
	d.pos += int(n)
	return s, nil
}
