package netutil

import (
	"crypto/tls"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestParsePrefixes(t *testing.T) {
	p, err := ParsePrefixes(" 127.0.0.1/32, ::1/128 ,10.1.2.3, 172.16.5.4/12,")
	if err != nil || len(p) != 4 {
		t.Fatalf("got %v %v", p, err)
	}
	if p[2].String() != "10.1.2.3/32" || p[3].String() != "172.16.0.0/12" {
		t.Fatalf("normalisation: %v", p)
	}
	for _, bad := range []string{"10.0.0.0/33", "nope", "1.2.3"} {
		if _, err := ParsePrefixes(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestResolver(t *testing.T) {
	trusted, _ := ParsePrefixes("127.0.0.1/32,10.0.0.0/8")
	rv := Resolver{Trusted: trusted}
	cases := []struct {
		name                       string
		remote, xff, proto, host   string
		tls                        bool
		wantIP, wantScheme, wantHo string
		wantFor                    string
	}{
		{"direct client", "203.0.113.5:1", "", "", "", false, "203.0.113.5", "http", "ui.local", "203.0.113.5"},
		{"untrusted peer spoofs", "203.0.113.5:1", "1.1.1.1", "https", "evil.com", false, "203.0.113.5", "http", "ui.local", "203.0.113.5"},
		{"trusted proxy", "127.0.0.1:1", "198.51.100.7", "https", "jackett.example.com", false, "198.51.100.7", "https", "jackett.example.com", "198.51.100.7, 127.0.0.1"},
		{"trusted chain, client spoofed left", "10.0.0.2:1", "6.6.6.6, 198.51.100.7, 10.0.0.9", "", "", false, "198.51.100.7", "http", "ui.local", "6.6.6.6, 198.51.100.7, 10.0.0.9, 10.0.0.2"},
		{"tls direct", "203.0.113.5:1", "", "", "", true, "203.0.113.5", "https", "ui.local", "203.0.113.5"},
		{"bad forwarded host ignored", "127.0.0.1:1", "", "", "evil.com/<x>", false, "127.0.0.1", "http", "ui.local", "127.0.0.1"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://ui.local/", nil)
			r.RemoteAddr = c.remote
			if c.xff != "" {
				r.Header.Set("X-Forwarded-For", c.xff)
			}
			if c.proto != "" {
				r.Header.Set("X-Forwarded-Proto", c.proto)
			}
			if c.host != "" {
				r.Header.Set("X-Forwarded-Host", c.host)
			}
			if c.tls {
				r.TLS = &tls.ConnectionState{}
			}
			if got := rv.ClientIP(r).String(); got != c.wantIP {
				t.Errorf("ClientIP = %s, want %s", got, c.wantIP)
			}
			if got := rv.Scheme(r); got != c.wantScheme {
				t.Errorf("Scheme = %s, want %s", got, c.wantScheme)
			}
			if got := rv.Host(r); got != c.wantHo {
				t.Errorf("Host = %s, want %s", got, c.wantHo)
			}
			if got := rv.ForwardedFor(r); got != c.wantFor {
				t.Errorf("ForwardedFor = %q, want %q", got, c.wantFor)
			}
		})
	}
}

func TestResolverPublicURLWins(t *testing.T) {
	u, _ := url.Parse("https://jackett.example.com")
	rv := Resolver{PublicURL: u}
	r := httptest.NewRequest("GET", "http://internal:8080/", nil)
	r.Header.Set("X-Forwarded-Proto", "http")
	if rv.Origin(r) != "https://jackett.example.com" || !rv.Secure(r) {
		t.Fatalf("origin = %s", rv.Origin(r))
	}
}
