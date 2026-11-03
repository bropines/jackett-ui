// Package auth holds the authentication building blocks: auth modes, the
// admin password (bcrypt), trusted-header authentication and the login rate
// limiter. The HTTP wiring lives in internal/httpapi; OIDC in auth/oidc.
package auth

import (
	"errors"
	"net/http"
	"net/netip"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"

	"github.com/bropines/jackett-ui/server/internal/netutil"
)

// Auth modes.
const (
	ModePassword = "password"
	ModeSSO      = "sso" // external providers (oidc, google, github)
	ModeHeader   = "header"
	ModeNone     = "none"
)

// AdminUser is the user name of the single password account.
const AdminUser = "admin"

// ValidMode reports whether m is a known mode.
func ValidMode(m string) bool {
	switch m {
	case ModePassword, ModeSSO, ModeHeader, ModeNone:
		return true
	}
	return false
}

// Identity is an authenticated caller.
type Identity struct {
	User string
	// Mode is the auth mode the identity was established under.
	Mode string
	// FromSession is true when the identity came from the session cookie.
	FromSession bool
}

// Authenticator authenticates a request. ok=false means "not authenticated"
// (the caller answers 401).
type Authenticator interface {
	Authenticate(r *http.Request) (id Identity, ok bool)
}

// ---- password ----

// BcryptCost is the cost for new password hashes.
const BcryptCost = 12

// MinPasswordLen is the minimum password length (in characters).
const MinPasswordLen = 8

// maxPasswordBytes is bcrypt's input limit.
const maxPasswordBytes = 72

// Password errors.
var (
	ErrPasswordTooShort = errors.New("password_too_short")
	ErrPasswordTooLong  = errors.New("password_too_long")
)

// ValidatePassword checks the password policy.
func ValidatePassword(pw string) error {
	if utf8.RuneCountInString(pw) < MinPasswordLen {
		return ErrPasswordTooShort
	}
	if len(pw) > maxPasswordBytes {
		return ErrPasswordTooLong
	}
	return nil
}

// HashPassword validates and hashes pw with BcryptCost.
func HashPassword(pw string) (string, error) {
	if err := ValidatePassword(pw); err != nil {
		return "", err
	}
	h, err := bcrypt.GenerateFromPassword([]byte(pw), BcryptCost)
	if err != nil {
		return "", err
	}
	return string(h), nil
}

// ValidHash reports whether h looks like a bcrypt hash.
func ValidHash(h string) bool {
	_, err := bcrypt.Cost([]byte(h))
	return err == nil
}

// dummyHash keeps the timing of a check without a configured hash similar.
var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("dummy-password-for-timing"), bcrypt.MinCost)

// CheckPassword reports whether pw matches the bcrypt hash. An empty hash
// never matches.
func CheckPassword(hash, pw string) bool {
	if hash == "" {
		_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(pw))
		return false
	}
	if len(pw) > maxPasswordBytes {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

// ---- trusted header ----

// maxHeaderUser bounds the user name taken from the header.
const maxHeaderUser = 256

// Header authenticates by a header set by a trusted reverse proxy
// (Authelia, Authentik outpost, oauth2-proxy …).
type Header struct {
	Name    string
	Trusted []netip.Prefix
}

// User returns the user from the header if the direct peer is trusted and
// the header is non-empty. X-Forwarded-For is deliberately ignored: the peer
// itself must be the trusted proxy.
func (h Header) User(r *http.Request) (string, bool) {
	if h.Name == "" || len(h.Trusted) == 0 {
		return "", false
	}
	if !netutil.Contains(h.Trusted, netutil.PeerIP(r)) {
		return "", false
	}
	v := strings.TrimSpace(r.Header.Get(h.Name))
	if v == "" || len(v) > maxHeaderUser || !utf8.ValidString(v) {
		return "", false
	}
	for _, c := range v {
		if c < 0x20 || c == 0x7f {
			return "", false
		}
	}
	return v, true
}

// Authenticate implements Authenticator.
func (h Header) Authenticate(r *http.Request) (Identity, bool) {
	u, ok := h.User(r)
	if !ok {
		return Identity{}, false
	}
	return Identity{User: u, Mode: ModeHeader}, true
}

// None authenticates everybody.
type None struct{}

// Authenticate implements Authenticator.
func (None) Authenticate(*http.Request) (Identity, bool) {
	return Identity{User: "anonymous", Mode: ModeNone}, true
}
