// Package netutil derives the effective client IP, scheme and host of a
// request. X-Forwarded-* headers are only honoured when the direct peer is in
// the trusted proxy list.
package netutil

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
)

// ParsePrefixes parses a comma separated list of CIDRs or bare IPs (a bare
// IP becomes /32 or /128).
func ParsePrefixes(s string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		p, err := ParsePrefix(part)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

// ParsePrefixList is ParsePrefixes for a slice.
func ParsePrefixList(list []string) ([]netip.Prefix, error) {
	out := make([]netip.Prefix, 0, len(list))
	for _, s := range list {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		p, err := ParsePrefix(s)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

// ParsePrefix parses one CIDR or bare IP.
func ParsePrefix(s string) (netip.Prefix, error) {
	if strings.Contains(s, "/") {
		p, err := netip.ParsePrefix(s)
		if err != nil {
			return netip.Prefix{}, fmt.Errorf("invalid CIDR %q", s)
		}
		return p.Masked(), nil
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Prefix{}, fmt.Errorf("invalid IP %q", s)
	}
	a = a.Unmap()
	return netip.PrefixFrom(a, a.BitLen()), nil
}

// Contains reports whether ip is in any of the prefixes.
func Contains(prefixes []netip.Prefix, ip netip.Addr) bool {
	if !ip.IsValid() {
		return false
	}
	ip = ip.Unmap()
	for _, p := range prefixes {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// PeerIP returns the IP of the direct TCP peer (r.RemoteAddr).
func PeerIP(r *http.Request) netip.Addr {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return a.Unmap()
}

// Resolver computes effective request values.
type Resolver struct {
	Trusted []netip.Prefix
	// PublicURL, when set, fixes the scheme and host (origin) for everything.
	PublicURL *url.URL
}

// TrustedPeer reports whether the direct peer is a trusted proxy.
func (rv Resolver) TrustedPeer(r *http.Request) bool {
	return Contains(rv.Trusted, PeerIP(r))
}

// ClientIP returns the client IP: the right-most X-Forwarded-For entry that
// is not a trusted proxy, when the peer is trusted; else the peer.
func (rv Resolver) ClientIP(r *http.Request) netip.Addr {
	peer := PeerIP(r)
	if !Contains(rv.Trusted, peer) {
		return peer
	}
	chain := forwardedFor(r)
	for i := len(chain) - 1; i >= 0; i-- {
		a := chain[i]
		if !Contains(rv.Trusted, a) {
			return a
		}
	}
	if len(chain) > 0 {
		return chain[0]
	}
	return peer
}

func forwardedFor(r *http.Request) []netip.Addr {
	var out []netip.Addr
	for _, v := range r.Header.Values("X-Forwarded-For") {
		for _, part := range strings.Split(v, ",") {
			part = strings.TrimSpace(part)
			if a, err := netip.ParseAddr(part); err == nil {
				out = append(out, a.Unmap())
			} else if ap, err := netip.ParseAddrPort(part); err == nil {
				out = append(out, ap.Addr().Unmap())
			}
		}
	}
	return out
}

// Scheme returns "https" or "http".
func (rv Resolver) Scheme(r *http.Request) string {
	if rv.PublicURL != nil {
		return rv.PublicURL.Scheme
	}
	if rv.TrustedPeer(r) {
		if p := firstValue(r.Header.Get("X-Forwarded-Proto")); p != "" {
			p = strings.ToLower(p)
			if p == "https" || p == "http" {
				return p
			}
		}
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

// Host returns the effective host[:port].
func (rv Resolver) Host(r *http.Request) string {
	if rv.PublicURL != nil {
		return rv.PublicURL.Host
	}
	if rv.TrustedPeer(r) {
		if h := firstValue(r.Header.Get("X-Forwarded-Host")); h != "" && validHost(h) {
			return h
		}
	}
	return r.Host
}

// Origin returns scheme://host.
func (rv Resolver) Origin(r *http.Request) string {
	return rv.Scheme(r) + "://" + rv.Host(r)
}

// Secure reports whether cookies should carry the Secure flag.
func (rv Resolver) Secure(r *http.Request) bool { return rv.Scheme(r) == "https" }

// ForwardedFor returns the X-Forwarded-For value to send upstream: the
// trusted chain plus the peer, or only the peer.
func (rv Resolver) ForwardedFor(r *http.Request) string {
	peer := PeerIP(r)
	ps := ""
	if peer.IsValid() {
		ps = peer.String()
	}
	if rv.TrustedPeer(r) {
		var parts []string
		for _, a := range forwardedFor(r) {
			parts = append(parts, a.String())
		}
		if ps != "" {
			parts = append(parts, ps)
		}
		return strings.Join(parts, ", ")
	}
	return ps
}

func firstValue(v string) string {
	if i := strings.IndexByte(v, ','); i >= 0 {
		v = v[:i]
	}
	return strings.TrimSpace(v)
}

func validHost(h string) bool {
	if len(h) > 255 {
		return false
	}
	for _, c := range h {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case strings.ContainsRune(".-:[]_", c):
		default:
			return false
		}
	}
	return true
}
