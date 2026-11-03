// Command jackett-ui serves the jackett-ui web UI, proxies the Jackett API and
// puts authentication in front of it. See docs/server-spec.md.
package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bropines/jackett-ui/server/internal/auth"
	"github.com/bropines/jackett-ui/server/internal/config"
	"github.com/bropines/jackett-ui/server/internal/httpapi"
	"github.com/bropines/jackett-ui/server/internal/jackett"
	"github.com/bropines/jackett-ui/server/internal/proxy"
	"github.com/bropines/jackett-ui/server/internal/store"
	"github.com/bropines/jackett-ui/server/web"
)

// version is set with -ldflags "-X main.version=…".
var version = "0.2.1"

func main() {
	// `jackett-ui healthcheck`: for Docker HEALTHCHECK in images without a shell or curl.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "jackett-ui:", err)
		os.Exit(1)
	}
}

func run() error {
	env, err := config.ParseEnv(os.LookupEnv)
	if err != nil {
		return fmt.Errorf("invalid configuration:\n%w", err)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: env.LogLevel}))
	slog.SetDefault(log)

	st, err := store.Open(env.DataDir)
	if err != nil {
		return err
	}
	if env.AuthReset {
		if err := authReset(st); err != nil {
			return err
		}
		log.Warn("AUTH_RESET: stored password and login providers removed, session key rotated, all sessions ended. " +
			"Open the UI to set a new password, then REMOVE AUTH_RESET from the environment (it resets on every start)")
	}

	eff, err := config.Resolve(env, st.Get())
	if err != nil {
		return err
	}
	if err := eff.Validate(); err != nil {
		return fmt.Errorf("invalid configuration: %w", err)
	}

	static, staticSrc, err := staticFS(env.StaticDir)
	if err != nil {
		return err
	}

	jc := jackett.New(env.JackettURL, env.JackettPassword, nil, log)
	px := proxy.New(jc, nil, log)
	srv := httpapi.New(httpapi.Options{
		Env:     env,
		Store:   st,
		Jackett: jc,
		Proxy:   px,
		Static:  static,
		Version: version,
		Log:     log,
	})

	log.Info("jackett-ui starting",
		"version", version,
		"listen", env.Listen,
		"jackett", env.JackettURL.String(),
		"dataDir", env.DataDir,
		"mode", eff.Mode.Value,
		"static", staticSrc,
		"fromEnv", env.Set, // names only, never values
	)
	switch {
	case eff.SetupRequired():
		log.Warn("no admin password set: open the UI to set one (Jackett stays unreachable until then)")
	case eff.Mode.Value == auth.ModeNone:
		log.Warn("auth mode is NONE: anyone who can reach this server controls Jackett")
	case eff.Mode.Value == auth.ModeSSO && !eff.AllowListSet():
		log.Warn("auth mode sso without any allow-list (AUTH_ALLOWED_EMAILS, GITHUB_USERS, OIDC_ALLOWED_GROUPS): external logins are refused")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Log in to Jackett early (it may still be starting; failures are retried on demand).
	go func() {
		s := jc.Status(ctx)
		if !s.OK {
			log.Warn("jackett not ready yet", "error", s.Error)
		}
	}()

	hs := &http.Server{
		Addr:              env.Listen,
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       2 * time.Minute,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
		BaseContext:       func(net.Listener) context.Context { return context.WithoutCancel(ctx) },
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelDebug),
	}
	errc := make(chan error, 1)
	go func() { errc <- hs.ListenAndServe() }()

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
	}
	log.Info("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := hs.Shutdown(sctx); err != nil {
		log.Warn("shutdown", "error", err)
		_ = hs.Close()
	}
	return nil
}

// healthcheck GETs /healthz on the local listener and returns the exit code.
func healthcheck() int {
	listen := os.Getenv("LISTEN")
	if listen == "" {
		listen = ":8080"
	}
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return 1
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	c := &http.Client{Timeout: 3 * time.Second}
	res, err := c.Get("http://" + net.JoinHostPort(host, port) + "/healthz")
	if err != nil {
		return 1
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

// authReset removes the stored credentials and providers, resets the mode
// and rotates the session key. Header and other settings are kept.
func authReset(st *store.Store) error {
	return st.Update(func(s *store.Settings) error {
		s.Auth.Mode = ""
		s.Auth.PasswordHash = ""
		s.Auth.PasswordFallback = nil
		s.Auth.Providers = store.Providers{}
		s.Auth.AllowedEmails = nil
		s.Auth.GitHubUsers = nil
		s.SessionKey = store.NewSessionKey()
		s.AuthEpoch++
		return nil
	})
}

// staticFS picks the UI files: STATIC_DIR, the embedded dist/, or the
// placeholder page.
func staticFS(dir string) (fs.FS, string, error) {
	if dir != "" {
		fsys := os.DirFS(dir)
		if _, err := fs.Stat(fsys, "index.html"); err != nil {
			return nil, "", fmt.Errorf("STATIC_DIR %s: no index.html", dir)
		}
		return fsys, dir, nil
	}
	if sub, err := fs.Sub(web.FS, "dist"); err == nil {
		if _, err := fs.Stat(sub, "index.html"); err == nil {
			return sub, "embedded", nil
		}
	}
	page, err := fs.ReadFile(web.FS, "placeholder.html")
	if err != nil {
		return nil, "", err
	}
	return indexOnlyFS(page), "placeholder", nil
}

// indexOnlyFS is an fs.FS with a single index.html.
type indexOnlyFS []byte

func (f indexOnlyFS) Open(name string) (fs.File, error) {
	if name != "index.html" {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
	return &memFile{Reader: bytes.NewReader(f), size: int64(len(f))}, nil
}

type memFile struct {
	*bytes.Reader
	size int64
}

func (m *memFile) Stat() (fs.FileInfo, error) { return m, nil }
func (m *memFile) Close() error               { return nil }
func (m *memFile) Name() string               { return "index.html" }
func (m *memFile) Size() int64                { return m.size }
func (m *memFile) Mode() fs.FileMode          { return 0o444 }
func (m *memFile) ModTime() time.Time         { return time.Time{} }
func (m *memFile) IsDir() bool                { return false }
func (m *memFile) Sys() any                   { return nil }
