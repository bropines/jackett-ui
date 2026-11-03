package oidc

import (
	"context"
	"errors"
	"net/http"
)

// Placeholder: replaced by the OIDC implementation task. Keep the signatures in api.go.
func newProvider(_ context.Context, cfg Config, _ *http.Client) (*Provider, error) {
	return nil, errors.Join(ErrNotConfigured, errors.New("not implemented"))
}
