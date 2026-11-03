package auth

import (
	"math"
	"net/netip"
	"sync"
	"time"
)

// Limiter is a per-IP limiter for login attempts: a token bucket (Rate per
// minute, Burst) plus exponential backoff after FailThreshold consecutive
// failures (1 s, 2 s, 4 s … capped at MaxBackoff).
type Limiter struct {
	PerMinute     float64
	Burst         float64
	FailThreshold int
	MaxBackoff    time.Duration
	MaxEntries    int
	Now           func() time.Time

	mu      sync.Mutex
	entries map[netip.Addr]*limEntry
}

type limEntry struct {
	tokens   float64
	last     time.Time
	fails    int
	blockTil time.Time
}

// NewLimiter returns the default limiter: 5/min, burst 5, backoff after 10
// consecutive failures.
func NewLimiter() *Limiter {
	return &Limiter{
		PerMinute:     5,
		Burst:         5,
		FailThreshold: 10,
		MaxBackoff:    15 * time.Minute,
		MaxEntries:    10000,
		Now:           time.Now,
		entries:       map[netip.Addr]*limEntry{},
	}
}

func (l *Limiter) now() time.Time {
	if l.Now != nil {
		return l.Now()
	}
	return time.Now()
}

func (l *Limiter) entry(ip netip.Addr, now time.Time) *limEntry {
	if l.entries == nil {
		l.entries = map[netip.Addr]*limEntry{}
	}
	e, ok := l.entries[ip]
	if !ok {
		if l.MaxEntries > 0 && len(l.entries) >= l.MaxEntries {
			l.gc(now)
		}
		e = &limEntry{tokens: l.Burst, last: now}
		l.entries[ip] = e
	}
	return e
}

// gc drops entries that are idle (full bucket, no block, no failures), and
// if that is not enough, everything older than an hour.
func (l *Limiter) gc(now time.Time) {
	for ip, e := range l.entries {
		l.refill(e, now)
		if e.tokens >= l.Burst && e.fails == 0 && !now.Before(e.blockTil) {
			delete(l.entries, ip)
		}
	}
	// Still full (many distinct IPs): drop entries that are not blocked, then
	// anything. Memory stays bounded; a sprayer only gains a few tokens.
	if len(l.entries) >= l.MaxEntries {
		for ip, e := range l.entries {
			if !now.Before(e.blockTil) {
				delete(l.entries, ip)
			}
		}
	}
	for ip := range l.entries {
		if len(l.entries) < l.MaxEntries {
			break
		}
		delete(l.entries, ip)
	}
}

func (l *Limiter) refill(e *limEntry, now time.Time) {
	el := now.Sub(e.last)
	if el > 0 {
		e.tokens = math.Min(l.Burst, e.tokens+el.Minutes()*l.PerMinute)
		e.last = now
	}
}

// Allow consumes one attempt for ip. If not allowed it returns how long to
// wait.
func (l *Limiter) Allow(ip netip.Addr) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	e := l.entry(ip, now)
	if now.Before(e.blockTil) {
		return false, ceilSecond(e.blockTil.Sub(now))
	}
	l.refill(e, now)
	if e.tokens < 1 {
		wait := time.Duration((1 - e.tokens) / l.PerMinute * float64(time.Minute))
		return false, ceilSecond(wait)
	}
	e.tokens--
	return true, 0
}

// Failure records a failed attempt.
func (l *Limiter) Failure(ip netip.Addr) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	e := l.entry(ip, now)
	e.fails++
	if e.fails >= l.FailThreshold {
		n := e.fails - l.FailThreshold
		d := time.Second
		for i := 0; i < n && d < l.MaxBackoff; i++ {
			d *= 2
		}
		d = min(d, l.MaxBackoff)
		e.blockTil = now.Add(d)
	}
}

// Success resets the failure counter for ip.
func (l *Limiter) Success(ip netip.Addr) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if e, ok := l.entries[ip]; ok {
		e.fails = 0
		e.blockTil = time.Time{}
	}
}

func ceilSecond(d time.Duration) time.Duration {
	if d <= 0 {
		return time.Second
	}
	return ((d + time.Second - 1) / time.Second) * time.Second
}
