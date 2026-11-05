package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"

	"github.com/bropines/jackett-ui/server/internal/auth"
	"github.com/bropines/jackett-ui/server/internal/config"
	"github.com/bropines/jackett-ui/server/internal/store"
	"github.com/bropines/jackett-ui/server/internal/users"
)

const resetUsage = `usage: jackett-ui reset-password <username> [--enable-password-login] [--no-wizard]

Sets a new password for the user (read from stdin: the first line, or two
prompts on a terminal), enables the user and ends its sessions. With
--enable-password-login the password login method is switched on as well.
For an admin the first-login wizard opens on the next login (rename the
account, set an own password); --no-wizard skips that.
A running server picks the change up by itself.`

// passwordReader returns the new password.
type passwordReader func() (string, error)

// stdinPassword reads the password from a terminal (twice, no echo) or the
// first line of piped input.
func stdinPassword(in *os.File, out io.Writer) passwordReader {
	return func() (string, error) {
		fd := int(in.Fd())
		if !term.IsTerminal(fd) {
			line, err := bufio.NewReader(in).ReadString('\n')
			if err != nil && !errors.Is(err, io.EOF) {
				return "", err
			}
			return strings.TrimRight(line, "\r\n"), nil
		}
		fmt.Fprint(out, "New password: ")
		a, err := term.ReadPassword(fd)
		fmt.Fprintln(out)
		if err != nil {
			return "", err
		}
		fmt.Fprint(out, "Repeat: ")
		b, err := term.ReadPassword(fd)
		fmt.Fprintln(out)
		if err != nil {
			return "", err
		}
		if string(a) != string(b) {
			return "", errors.New("passwords don't match")
		}
		return string(a), nil
	}
}

// resetPassword implements `jackett-ui reset-password`.
func resetPassword(args []string, lookup func(string) (string, bool), readPW passwordReader, out io.Writer) error {
	var name string
	enableLogin, noWizard := false, false
	for _, a := range args {
		switch {
		case a == "--enable-password-login":
			enableLogin = true
		case a == "--no-wizard":
			noWizard = true
		case a == "-h" || a == "--help":
			fmt.Fprintln(out, resetUsage)
			return nil
		case strings.HasPrefix(a, "-"):
			return fmt.Errorf("unknown flag %s\n\n%s", a, resetUsage)
		case name != "":
			return errors.New(resetUsage)
		default:
			name = users.NormalizeUsername(a)
		}
	}
	if name == "" {
		return errors.New(resetUsage)
	}
	env, err := config.ParseEnv(lookup)
	if err != nil {
		return fmt.Errorf("invalid configuration:\n%w", err)
	}
	if enableLogin && env.Methods != nil {
		return errors.New("--enable-password-login: login methods are set by AUTH_METHODS; add password there instead")
	}
	st, err := store.Open(env.DataDir)
	if err != nil {
		return err
	}
	if cur := st.Get(); users.ByUsername(&cur, name) == nil {
		return fmt.Errorf("no user %q", name)
	}
	pw, err := readPW()
	if err != nil {
		return err
	}
	hash, err := auth.HashPassword(pw)
	if err != nil {
		return err
	}
	err = st.Update(func(s *store.Settings) error {
		u := users.ByUsername(s, name)
		if u == nil {
			return fmt.Errorf("no user %q", name)
		}
		u.PasswordHash, u.Bootstrap, u.Disabled = hash, false, false
		u.Epoch++
		if u.Role == store.RoleAdmin {
			// The initial admin is now an ordinary account (so a restart doesn't
			// hand it the env password again); the wizard opens on the next login.
			s.Onboarded = true
			u.Onboard = !noWizard
		}
		if enableLogin {
			s.Auth.Methods.Password = true
			s.Auth.Disabled = false
		}
		return nil
	})
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "Password of %q changed, the user is enabled and its sessions ended.\n", name)
	if cur := st.Get(); users.ByUsername(&cur, name).Onboard {
		fmt.Fprintln(out, "The first-login wizard opens on the next login.")
	}
	if enableLogin {
		fmt.Fprintln(out, "Password login is switched on.")
	} else if cur := st.Get(); !cur.Auth.Methods.Password && env.Methods == nil {
		fmt.Fprintln(out, "Note: password login is switched off; rerun with --enable-password-login to turn it on.")
	}
	return nil
}
