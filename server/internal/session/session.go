// Package session implements the jui_session cookie: an HMAC-SHA256 signed
// JSON payload {u, m, e, x}. Sessions are rejected when the signature is
// wrong, the expiry passed, or the auth epoch / mode differ from the current
// ones (epoch-based invalidation: logout-all, password change, mode change).
package session

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// CookieName is the session cookie name.
const CookieName = "jui_session"

// maxTokenLen bounds the work done on attacker-supplied cookies.
const maxTokenLen = 4096

// Signer signs and verifies opaque payloads: base64url(payload) "."
// base64url(hmac). It satisfies oidc.Signer.
type Signer struct {
	key []byte
}

// NewSigner derives a purpose-bound key from the master key, so a value
// signed for one purpose (e.g. the OIDC flow cookie) is never accepted for
// another (the session cookie).
func NewSigner(master []byte, purpose string) *Signer {
	m := hmac.New(sha256.New, master)
	m.Write([]byte("jackett-ui/" + purpose))
	return &Signer{key: m.Sum(nil)}
}

func (s *Signer) mac(payload []byte) []byte {
	m := hmac.New(sha256.New, s.key)
	m.Write(payload)
	return m.Sum(nil)
}

// Sign returns the signed token for payload.
func (s *Signer) Sign(payload []byte) string {
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(s.mac(payload))
}

// Verify checks token and returns its payload.
func (s *Signer) Verify(token string) ([]byte, bool) {
	if len(token) > maxTokenLen {
		return nil, false
	}
	p, sig, ok := strings.Cut(token, ".")
	if !ok {
		return nil, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(p)
	if err != nil {
		return nil, false
	}
	got, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil {
		return nil, false
	}
	if !hmac.Equal(got, s.mac(payload)) {
		return nil, false
	}
	return payload, true
}

// Session is the cookie payload.
type Session struct {
	User   string `json:"u"`
	Mode   string `json:"m"`
	Epoch  uint64 `json:"e"`
	Expiry int64  `json:"x"` // unix seconds
}

// Manager issues and checks session cookies.
type Manager struct {
	Signer *Signer
	Now    func() time.Time
}

// NewManager returns a Manager for the master session key.
func NewManager(master []byte) *Manager {
	return &Manager{Signer: NewSigner(master, "session"), Now: time.Now}
}

func (m *Manager) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}

// Encode returns the cookie value for s.
func (m *Manager) Encode(s Session) string {
	b, _ := json.Marshal(s)
	return m.Signer.Sign(b)
}

// Decode verifies a cookie value and checks expiry, epoch and mode.
func (m *Manager) Decode(token, mode string, epoch uint64) (Session, bool) {
	payload, ok := m.Signer.Verify(token)
	if !ok {
		return Session{}, false
	}
	var s Session
	if err := json.Unmarshal(payload, &s); err != nil {
		return Session{}, false
	}
	if s.User == "" || s.Mode != mode || s.Epoch != epoch || m.now().Unix() >= s.Expiry {
		return Session{}, false
	}
	return s, true
}

// New creates a session valid for ttl.
func (m *Manager) New(user, mode string, epoch uint64, ttl time.Duration) Session {
	return Session{User: user, Mode: mode, Epoch: epoch, Expiry: m.now().Add(ttl).Unix()}
}

// NeedsRenewal reports whether more than half of ttl has passed.
func (m *Manager) NeedsRenewal(s Session, ttl time.Duration) bool {
	remaining := time.Unix(s.Expiry, 0).Sub(m.now())
	return remaining < ttl/2
}

// Cookie returns the Set-Cookie for s.
func (m *Manager) Cookie(s Session, secure bool) *http.Cookie {
	exp := time.Unix(s.Expiry, 0)
	return &http.Cookie{
		Name:     CookieName,
		Value:    m.Encode(s),
		Path:     "/",
		Expires:  exp,
		MaxAge:   max(1, int(exp.Sub(m.now())/time.Second)),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	}
}

// ClearCookie returns a Set-Cookie that removes the session cookie.
func ClearCookie(secure bool) *http.Cookie {
	return &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	}
}
