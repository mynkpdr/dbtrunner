# Sandbox DBT Runner

Lightweight Cloudflare Worker that runs DBT projects inside ephemeral Sandbox containers and streams logs back to the client via Server-Sent Events (SSE).

**Key endpoints**

- POST /auth — Verify a Google ID token and return a signed JWT for subsequent requests.
  - Request: JSON { "id_token": "<Google ID token>" }
  - Response: { "token": "<JWT>", "user": { sub, email, name, picture } }

- POST /api/run — Submit a DBT project archive (multipart/form-data) and receive a real-time SSE stream of logs.
  - Headers: `Authorization: Bearer <JWT>`
  - Body: form field `project_zip` containing a ZIP file of the DBT project
  - Response: text/event-stream (SSE) lines `data: ...`

Requirements

- Node.js (for running Wrangler locally)
- Wrangler (>= v4)
- Docker (for building/using the local Sandbox image when running `wrangler dev`)

Important configuration

- Secrets (store with `wrangler secret put`):
  - `JWT_SECRET` — random secret used to sign HS256 JWTs
  - `GOOGLE_CLIENT_ID` — (optional) Google OAuth client id to validate tokens
- Optional environment variables (comma-separated strings):
  - `ALLOWED_EMAIL_DOMAINS` — restrict sign-ins to domains (example: example.com,acme.org)
  - `ALLOWED_EMAILS` — allowlist specific addresses
- Sandbox binding: `Sandbox` Durable Object is declared in `wrangler.jsonc` and the container image is built from `Dockerfile`.

Local development

1. Install dependencies

```bash
npm install
```

2. Add required secrets

```bash
wrangler secret put JWT_SECRET
wrangler secret put GOOGLE_CLIENT_ID   # optional
```

3. Start the local dev environment

```bash
wrangler dev
```

Examples

- Get a JWT from Google ID token (replace <ID_TOKEN>):

```bash
curl -s -X POST http://localhost:8787/auth \
  -H "Content-Type: application/json" \
  -d '{"id_token":"<ID_TOKEN>"}'
```

- Run a DBT project and stream logs (replace <JWT> and project.zip):

```bash
curl -N -X POST http://localhost:8787/api/run \
  -H "Authorization: Bearer <JWT>" \
  -H "Accept: text/event-stream" \
  -F "project_zip=@project.zip"
```

Notes

- The Worker streams logs as SSE events. Use `curl -N` or a browser EventSource to consume the stream.
- The included `Dockerfile` builds a Sandbox image with Python and common DBT dependencies; adjust it if your DBT runner image requires different packages.
- `wrangler dev` provisions local sandbox containers; container startup can take a short time on first run.

Contributing / Troubleshooting

- Use `npm run typecheck` to validate TypeScript.
- If `wrangler dev` reports missing Durable Object exports, ensure `src/index.ts` exports `Sandbox` (this project does so).
- For container-related 5xx errors during `sandbox.createSession` or similar, check the Wrangler logs and the local Docker environment (image build / available resources).
