package jackett_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/bropines/jackett-ui/server/internal/jackett"
	"github.com/bropines/jackett-ui/server/internal/jackett/jackettfake"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func client(t *testing.T, f *jackettfake.Fake, pw string) *jackett.Client {
	t.Helper()
	u, _ := url.Parse(f.Server.URL)
	return jackett.New(u, pw, nil, quiet)
}

func TestLoginAndStatus(t *testing.T) {
	f := jackettfake.New("adminpw")
	defer f.Close()
	c := client(t, f, "adminpw")
	if err := c.Relogin(context.Background(), 0); err != nil {
		t.Fatal(err)
	}
	cookie, gen := c.Cookie()
	if cookie == "" || gen != 1 {
		t.Fatalf("cookie %q gen %d", cookie, gen)
	}
	st := c.Status(context.Background())
	if !st.OK || st.Version != "v"+jackettfake.Version {
		t.Fatalf("status %+v", st)
	}
	// The login POST carried the form password and was not followed.
	if s, ok := f.Last("/UI/Dashboard"); !ok || s.Body != "password=adminpw" {
		t.Fatalf("login request: %+v", s)
	}
	if _, ok := f.Last("/UI/Dashboard"); !ok {
		t.Fatal("no login")
	}
	if _, followed := f.Last("/Dashboard"); followed {
		t.Fatal("redirect was followed")
	}
}

func TestNoAdminPassword(t *testing.T) {
	f := jackettfake.New("")
	defer f.Close()
	c := client(t, f, "")
	if st := c.Status(context.Background()); !st.OK {
		t.Fatalf("status %+v", st)
	}
}

func TestWrongPassword(t *testing.T) {
	f := jackettfake.New("adminpw")
	defer f.Close()
	c := client(t, f, "wrong")
	err := c.Relogin(context.Background(), 0)
	if !errors.Is(err, jackett.ErrLoginFailed) {
		t.Fatalf("err = %v", err)
	}
	st := c.Status(context.Background())
	if st.OK || st.Error != "jackett_login_failed" {
		t.Fatalf("status %+v", st)
	}
	// Fail-fast backoff: no new login attempts right away.
	n := f.Logins.Load()
	_, gen := c.Cookie()
	_ = c.Relogin(context.Background(), gen)
	if f.Logins.Load() != n {
		t.Fatal("re-login storm despite backoff")
	}
	c.FailBackoff = 0
	_, gen = c.Cookie()
	_ = c.Relogin(context.Background(), gen)
	if f.Logins.Load() != n+1 {
		t.Fatal("no retry after backoff")
	}
}

func TestUnreachable(t *testing.T) {
	u, _ := url.Parse("http://127.0.0.1:1")
	c := jackett.New(u, "", nil, quiet)
	if err := c.Relogin(context.Background(), 0); !errors.Is(err, jackett.ErrUnreachable) {
		t.Fatalf("err = %v", err)
	}
	if st := c.Status(context.Background()); st.OK || st.Error != "jackett_unreachable" {
		t.Fatalf("status %+v", st)
	}
}

func TestReloginCoalesced(t *testing.T) {
	f := jackettfake.New("adminpw")
	defer f.Close()
	f.LoginDelay = 100 * time.Millisecond
	c := client(t, f, "adminpw")
	_, gen := c.Cookie()
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- c.Relogin(context.Background(), gen)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if n := f.Logins.Load(); n != 1 {
		t.Fatalf("logins = %d, want 1", n)
	}
	// A caller holding an old generation doesn't log in again.
	_ = c.Relogin(context.Background(), gen)
	if n := f.Logins.Load(); n != 1 {
		t.Fatalf("stale caller logged in again (%d)", n)
	}
}

func TestStatusCached(t *testing.T) {
	f := jackettfake.New("")
	defer f.Close()
	c := client(t, f, "")
	c.Status(context.Background())
	n := len(f.Seen())
	c.Status(context.Background())
	if len(f.Seen()) != n {
		t.Fatal("status not cached")
	}
}
