// Package web embeds the built UI. The Docker build copies the frontend's dist/
// into server/web/dist before `go build`; without it the placeholder page is served.
package web

import "embed"

// FS holds dist/ (when present) and placeholder.html.
//
//go:embed all:*
var FS embed.FS
