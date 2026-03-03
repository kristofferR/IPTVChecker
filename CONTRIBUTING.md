# Contributing

## CI Checks

Pull requests and pushes to `main` run the `CI` workflow at `.github/workflows/ci.yml`.

The workflow runs:

- Frontend checks:
  - `bun install --frozen-lockfile`
  - `bun run typecheck`
  - `bun run build`
- Backend checks:
  - `cd src-tauri && cargo test`

## Run Checks Locally

Run the same checks before opening a pull request:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run build
cd src-tauri && cargo test
```

## Release Security Checklist

Before creating a release build, verify:

- `src-tauri/tauri.conf.json` keeps a non-null CSP and does not add broad remote origins.
- `src-tauri/capabilities/default.json` permissions remain least-privilege for current UI features.
- No new Tauri plugins are enabled without corresponding capability review.
- Local file access stays mediated by backend commands with path validation (no broad frontend fs access).
- `bun run build` and `cd src-tauri && cargo test` pass after any security-related config changes.
