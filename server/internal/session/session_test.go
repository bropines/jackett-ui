package session

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/bropines/jackett-ui/server/internal/auth/oidc"
)

var _ oidc.Signer = (*Signer)(nil)

func key(b byte) []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = b
	}
	return k
}

func TestSignVerify(t *testing.T) {
	s := NewSigner(key(1), "session")
	tok := s.Sign([]byte("hello"))
	got, ok := s.Verify(tok)
	if !ok || string(got) != "hello" {
		t.Fatalf("verify failed: %q %v", got, ok)
	}
	p, sig, _ := strings.Cut(tok, ".")
	cases := map[string]string{
		"empty":         "",
		"no dot":        p,
		"tampered body": "aGVsbG8x." + sig,
		"tampered sig":  p + "." + sig[:len(sig)-2] + "AA",
		"bad base64":    "!!!." + sig,
		"other key":     NewSigner(key(2), "session").Sign([]byte("hello")),
		"other purpose": NewSigner(key(1), "login-flow").Sign([]byte("hello")),
		"too long":      strings.Repeat("a", 5000) + "." + sig,
	}
	for name, tok := range cases {
		if _, ok := s.Verify(tok); ok {
			t.Errorf("%s: verified", name)
		}
	}
}

func TestSessionDecode(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	m := NewManager(key(1))
	m.Now = func() time.Time { return now }
	ttl := time.Hour
	good := m.Encode(m.New("admin", "password", 3, ttl))

	type tc struct {
		name  string
		tok   string
		mode  string
		epoch uint64
		at    time.Time
		ok    bool
	}
	cases := []tc{
		{"valid", good, "password", 3, now, true},
		{"wrong epoch", good, "password", 4, now, false},
		{"wrong mode", good, "sso", 3, now, false},
		{"expired", good, "password", 3, now.Add(ttl), false},
		{"just before expiry", good, "password", 3, now.Add(ttl - time.Second), true},
		{"empty user", m.Encode(Session{User: "", Mode: "password", Epoch: 3, Expiry: now.Add(ttl).Unix()}), "password", 3, now, false},
		{"other key", NewManager(key(9)).Encode(m.New("admin", "password", 3, ttl)), "password", 3, now, false},
		{"garbage", "x.y", "password", 3, now, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			at := c.at
			m.Now = func() time.Time { return at }
			_, ok := m.Decode(c.tok, c.mode, c.epoch)
			if ok != c.ok {
				t.Fatalf("ok = %v, want %v", ok, c.ok)
			}
		})
	}
}

func TestRenewalAndCookie(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	m := NewManager(key(1))
	m.Now = func() time.Time { return now }
	ttl := 10 * time.Hour
	s := m.New("u", "password", 1, ttl)
	if m.NeedsRenewal(s, ttl) {
		t.Fatal("fresh session needs renewal")
	}
	m.Now = func() time.Time { return now.Add(6 * time.Hour) }
	if !m.NeedsRenewal(s, ttl) {
		t.Fatal("session past half TTL not renewed")
	}
	c := m.Cookie(s, true)
	if c.Name != CookieName || !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteLaxMode || c.Path != "/" || c.MaxAge <= 0 {
		t.Fatalf("bad cookie attrs: %+v", c)
	}
	if m.Cookie(s, false).Secure {
		t.Fatal("Secure set for http")
	}
	cl := ClearCookie(true)
	if cl.MaxAge >= 0 || cl.Value != "" {
		t.Fatalf("bad clear cookie: %+v", cl)
	}
}
