# syntax=docker/dockerfile:1
# jackett-ui: the UI + its Go server (login, Jackett API proxy). Run it next to a Jackett instance.
FROM node:22-alpine AS ui
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM golang:1.27-alpine AS server
ARG VERSION=dev
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
COPY --from=ui /app/dist ./web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/jackett-ui .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /out/jackett-ui /jackett-ui
ENV LISTEN=:8080 \
    JACKETT_URL=http://jackett:9117 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD ["/jackett-ui", "healthcheck"]
ENTRYPOINT ["/jackett-ui"]
LABEL org.opencontainers.image.title="jackett-ui" \
      org.opencontainers.image.description="Modern web UI for Jackett with built-in login (password, OIDC, Google, GitHub)" \
      org.opencontainers.image.source="https://github.com/bropines/jackett-ui"
