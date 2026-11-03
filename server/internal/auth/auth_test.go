package auth

import (
	"errors"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestValidatePassword(t *testing.T) {
	cases := []struct {
		pw   string
		want error
	}{
		{"", ErrPasswordTooShort},
		{"1234567", ErrPasswordTooShort},
		{"12345678", nil},
		{"пароль12", nil}, // 8 runes, 14 bytes
		{strings.Repeat("a", 72), nil},
		{strings.Repeat("a", 73), ErrPasswordTooLong},
	}
	for _, c := range cases {
		if err := ValidatePassword(c.pw); !errors.Is(err, c.want) {
			t.Errorf("%q: err = %v, want %v", c.pw, err, c.want)
		}
	}
}

func TestHashAndCheck(t *testing.T) {
	h, err := HashPassword("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if !ValidHash(h) || !strings.HasPrefix(h, "$2a$12$") {
		t.Fatalf("unexpected hash %q", h)
	}
	if !CheckPassword(h, "correct horse") {
		t.Fatal("right password rejected")
	}
	for _, bad := range []string{"", "correct hors", "Correct horse", strings.Repeat("x", 100)} {
		if CheckPassword(h, bad) {
			t.Errorf("wrong password %q accepted", bad)
		}
	}
	if CheckPassword("", "anything") {
		t.Fatal("empty hash matched")
	}
	if ValidHash("not-a-hash") {
		t.Fatal("ValidHash accepted junk")
	}
	if _, err := HashPassword("short"); !errors.Is(err, ErrPasswordTooShort) {
		t.Fatal("short password hashed")
	}
}

func TestHeaderTrust(t *testing.T) {
	h := Header{Name: "Remote-User", Trusted: []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}}
	cases := []struct {
		name   string
		remote string
		value  string
		xff    string
		ok     bool
	}{
		{"trusted peer", "10.1.2.3:5000", "alice", "", true},
		{"untrusted peer", "192.168.1.5:5000", "alice", "", false},
		{"untrusted peer spoofing XFF", "192.168.1.5:5000", "alice", "10.0.0.1", false},
		{"trusted but empty", "10.1.2.3:5000", "  ", "", false},
		{"control chars", "10.1.2.3:5000", "al\x01ice", "", false},
		{"too long", "10.1.2.3:5000", strings.Repeat("a", 300), "", false},
		{"ipv4-mapped v6 peer", "[::ffff:10.0.0.9]:1", "bob", "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			r.RemoteAddr = c.remote
			if c.value != "" {
				r.Header.Set("Remote-User", c.value)
			}
			if c.xff != "" {
				r.Header.Set("X-Forwarded-For", c.xff)
			}
			u, ok := h.User(r)
			if ok != c.ok {
				t.Fatalf("ok = %v (user %q), want %v", ok, u, c.ok)
			}
			if ok && u != strings.TrimSpace(c.value) {
				t.Fatalf("user = %q", u)
			}
		})
	}
	if _, ok := (Header{Name: "Remote-User"}).User(httptest.NewRequest("GET", "/", nil)); ok {
		t.Fatal("header without trusted CIDRs accepted")
	}
}

func TestLimiterBurstAndRefill(t *testing.T) {
	now := time.Unix(1000, 0)
	l := NewLimiter()
	l.Now = func() time.Time { return now }
	ip := netip.MustParseAddr("1.2.3.4")
	other := netip.MustParseAddr("5.6.7.8")
	for i := 0; i < 5; i++ {
		if ok, _ := l.Allow(ip); !ok {
			t.Fatalf("attempt %d refused", i+1)
		}
	}
	ok, wait := l.Allow(ip)
	if ok || wait <= 0 || wait > 12*time.Second {
		t.Fatalf("6th attempt: ok=%v wait=%v", ok, wait)
	}
	if ok, _ := l.Allow(other); !ok {
		t.Fatal("other IP limited")
	}
	now = now.Add(12 * time.Second) // 5/min = one token per 12 s
	if ok, _ := l.Allow(ip); !ok {
		t.Fatal("no refill after 12s")
	}
	if ok, _ := l.Allow(ip); ok {
		t.Fatal("refilled more than one token")
	}
}

func TestLimiterBackoff(t *testing.T) {
	now := time.Unix(1000, 0)
	l := NewLimiter()
	l.Now = func() time.Time { return now }
	ip := netip.MustParseAddr("1.2.3.4")
	for i := 0; i < 9; i++ {
		l.Failure(ip)
	}
	now = now.Add(time.Hour) // refill fully
	if ok, _ := l.Allow(ip); !ok {
		t.Fatal("blocked before threshold")
	}
	l.Failure(ip) // 10th
	ok, wait := l.Allow(ip)
	if ok || wait != time.Second {
		t.Fatalf("after 10 failures: ok=%v wait=%v, want 1s block", ok, wait)
	}
	now = now.Add(time.Second)
	l.Failure(ip) // 11th → 2 s
	if _, wait := l.Allow(ip); wait != 2*time.Second {
		t.Fatalf("after 11 failures wait = %v, want 2s", wait)
	}
	for i := 0; i < 40; i++ {
		l.Failure(ip)
	}
	if _, wait := l.Allow(ip); wait != l.MaxBackoff {
		t.Fatalf("backoff not capped: %v", wait)
	}
	l.Success(ip)
	now = now.Add(time.Hour)
	if ok, _ := l.Allow(ip); !ok {
		t.Fatal("success did not reset the backoff")
	}
}

func TestLimiterBoundedMemory(t *testing.T) {
	l := NewLimiter()
	l.MaxEntries = 100
	for i := 0; i < 1000; i++ {
		l.Allow(netip.AddrFrom4([4]byte{10, 0, byte(i >> 8), byte(i)}))
	}
	if len(l.entries) > 200 {
		t.Fatalf("limiter grew to %d entries", len(l.entries))
	}
}

func TestModes(t *testing.T) {
	for _, m := range []string{"password", "sso", "header", "none"} {
		if !ValidMode(m) {
			t.Errorf("%s invalid", m)
		}
	}
	for _, m := range []string{"", "oidc", "PASSWORD", "basic"} {
		if ValidMode(m) {
			t.Errorf("%s valid", m)
		}
	}
	if id, ok := (None{}).Authenticate(httptest.NewRequest("GET", "/", nil)); !ok || id.Mode != ModeNone {
		t.Fatal("none mode rejected")
	}
}
