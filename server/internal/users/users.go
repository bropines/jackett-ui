// Package users holds the account helpers of jackett-ui v0.3: user name
// rules, API token and invite secrets (generation, hashing, lookup) and
// lookups on the stored settings. It has no HTTP or policy logic.
package users

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"math/big"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/bropines/jackett-ui/server/internal/store"
)

// Limits.
const (
	MinUsernameLen   = 2
	MaxUsernameLen   = 32
	MaxNameLen       = 64
	MaxTokensPerUser = 20
	MaxTokenNameLen  = 64
	// TokenPrefix starts every API token.
	TokenPrefix = "jui_"
	// tokenRandLen: 32 base62 characters ≈ 190 bits.
	tokenRandLen = 32
	// DisplayPrefixLen is the part of a token kept for display.
	DisplayPrefixLen = 8
)

const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// ValidUsername: [a-z0-9._-]{2,32}.
func ValidUsername(s string) bool {
	if len(s) < MinUsernameLen || len(s) > MaxUsernameLen {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// NormalizeUsername trims and lower-cases s.
func NormalizeUsername(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// ValidName: display name, at most MaxNameLen characters, no control characters.
func ValidName(s string) bool {
	if utf8.RuneCountInString(s) > MaxNameLen || !utf8.ValidString(s) {
		return false
	}
	for _, c := range s {
		if c < 0x20 || c == 0x7f {
			return false
		}
	}
	return true
}

// DeriveUsername turns base (an e-mail, a login, a header value) into a
// valid, unused user name: the e-mail's local part, lower-cased, invalid
// characters replaced with '-', then "-2", "-3"… until it is free.
func DeriveUsername(base string, taken func(string) bool) string {
	base = strings.ToLower(strings.TrimSpace(base))
	if i := strings.IndexByte(base, '@'); i >= 0 {
		base = base[:i]
	}
	var b strings.Builder
	for _, c := range base {
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '.', c == '_', c == '-':
			b.WriteRune(c)
		default:
			b.WriteByte('-')
		}
	}
	name := strings.Trim(b.String(), ".-_")
	if len(name) > MaxUsernameLen {
		name = name[:MaxUsernameLen]
	}
	if len(name) < MinUsernameLen {
		name = "user"
	}
	if !taken(name) {
		return name
	}
	for i := 2; ; i++ {
		suffix := "-" + strconv.Itoa(i)
		n := name
		if len(n)+len(suffix) > MaxUsernameLen {
			n = n[:MaxUsernameLen-len(suffix)]
		}
		if !taken(n + suffix) {
			return n + suffix
		}
	}
}

func randomBase62(n int) string {
	out := make([]byte, n)
	max := big.NewInt(int64(len(base62)))
	for i := range out {
		v, err := rand.Int(rand.Reader, max)
		if err != nil {
			panic("users: crypto/rand failed: " + err.Error())
		}
		out[i] = base62[v.Int64()]
	}
	return string(out)
}

// HashSecret is the stored form of a token or invite secret: sha256 hex.
func HashSecret(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// NewToken returns a new API token, its display prefix and its hash.
func NewToken() (token, prefix, hash string) {
	token = TokenPrefix + randomBase62(tokenRandLen)
	return token, token[:DisplayPrefixLen], HashSecret(token)
}

// LooksLikeToken: the jui_ format (cheap pre-check before hashing).
func LooksLikeToken(s string) bool {
	if len(s) != len(TokenPrefix)+tokenRandLen || !strings.HasPrefix(s, TokenPrefix) {
		return false
	}
	for _, c := range s[len(TokenPrefix):] {
		if !strings.ContainsRune(base62, c) {
			return false
		}
	}
	return true
}

// NewInviteSecret returns a one-time invite secret and its hash.
func NewInviteSecret() (secret, hash string) {
	secret = randomBase62(tokenRandLen)
	return secret, HashSecret(secret)
}

// ValidInviteSecret: the format of NewInviteSecret.
func ValidInviteSecret(s string) bool {
	if len(s) != tokenRandLen {
		return false
	}
	for _, c := range s {
		if !strings.ContainsRune(base62, c) {
			return false
		}
	}
	return true
}

// FindToken returns the stored token for the secret tok (nil if none). The
// hash comparison is constant-time and every token is compared.
func FindToken(s *store.Settings, tok string) *store.Token {
	if !LooksLikeToken(tok) {
		return nil
	}
	h := []byte(HashSecret(tok))
	var found *store.Token
	for i := range s.Tokens {
		if subtle.ConstantTimeCompare([]byte(s.Tokens[i].Hash), h) == 1 {
			found = &s.Tokens[i]
		}
	}
	return found
}

// FindInvite returns the invite for the secret (nil if none).
func FindInvite(s *store.Settings, secret string) *store.Invite {
	if !ValidInviteSecret(secret) {
		return nil
	}
	return FindInviteByHash(s, HashSecret(secret))
}

// FindInviteByHash returns the invite with the secret hash h (nil if none).
func FindInviteByHash(s *store.Settings, h string) *store.Invite {
	var found *store.Invite
	for i := range s.Invites {
		if subtle.ConstantTimeCompare([]byte(s.Invites[i].Hash), []byte(h)) == 1 {
			found = &s.Invites[i]
		}
	}
	return found
}

// ByUsername returns the user with name (case-insensitive), nil if none.
func ByUsername(s *store.Settings, name string) *store.User {
	name = NormalizeUsername(name)
	for i := range s.Users {
		if s.Users[i].Username == name {
			return &s.Users[i]
		}
	}
	return nil
}

// ByIdentity returns the user that has the identity linked, nil if none.
func ByIdentity(s *store.Settings, provider, issuer, subject string) *store.User {
	for i := range s.Users {
		for _, id := range s.Users[i].Identities {
			if id.Provider == provider && id.Issuer == issuer && id.Subject == subject {
				return &s.Users[i]
			}
		}
	}
	return nil
}

// UsernameTaken returns a "taken" func for DeriveUsername.
func UsernameTaken(s *store.Settings) func(string) bool {
	return func(n string) bool { return ByUsername(s, n) != nil }
}

// EnabledAdmins counts enabled admins.
func EnabledAdmins(s *store.Settings) int {
	n := 0
	for _, u := range s.Users {
		if u.Role == store.RoleAdmin && !u.Disabled {
			n++
		}
	}
	return n
}

// TokenCount counts the tokens of user id.
func TokenCount(s *store.Settings, uid string) int {
	n := 0
	for _, t := range s.Tokens {
		if t.UserID == uid {
			n++
		}
	}
	return n
}

// DeleteTokensOf removes all tokens of user id.
func DeleteTokensOf(s *store.Settings, uid string) {
	out := s.Tokens[:0]
	for _, t := range s.Tokens {
		if t.UserID != uid {
			out = append(out, t)
		}
	}
	s.Tokens = out
}

// PruneInvites drops expired invites.
func PruneInvites(s *store.Settings, now time.Time) {
	out := s.Invites[:0]
	for _, i := range s.Invites {
		if now.Before(i.ExpiresAt) {
			out = append(out, i)
		}
	}
	s.Invites = out
}

// MaxEmailLen is the longest accepted e-mail address.
const MaxEmailLen = 254

// NormalizeEmail trims and lower-cases s.
func NormalizeEmail(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// ValidEmail is a loose check: one "@" with text on both sides, no spaces
// or control characters, at most MaxEmailLen bytes.
func ValidEmail(s string) bool {
	if len(s) > MaxEmailLen || !utf8.ValidString(s) {
		return false
	}
	at := strings.IndexByte(s, '@')
	if at <= 0 || at != strings.LastIndexByte(s, '@') || at == len(s)-1 {
		return false
	}
	for _, c := range s {
		if c <= 0x20 || c == 0x7f {
			return false
		}
	}
	return true
}

// ByEmail returns the user with this (normalised) e-mail, nil if none or empty.
func ByEmail(s *store.Settings, email string) *store.User {
	if email == "" {
		return nil
	}
	for i := range s.Users {
		if s.Users[i].Email == email {
			return &s.Users[i]
		}
	}
	return nil
}

// BootstrapUser returns the user whose password is AUTH_PASSWORD, nil if none.
func BootstrapUser(s *store.Settings) *store.User {
	for i := range s.Users {
		if s.Users[i].Bootstrap {
			return &s.Users[i]
		}
	}
	return nil
}
