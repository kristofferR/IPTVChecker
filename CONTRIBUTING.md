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

