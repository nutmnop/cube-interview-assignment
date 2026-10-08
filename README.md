# Product Health Take-Home

Public-safe Next.js monolith slice for a developer take-home.

This Next.js app uses 500,000 PostgreSQL fixture observations to reproduce
memory pressure during Product Health exports. Production Digital Shelf data
normally comes from Snowflake.

The original export loaded all results and built the CSV in memory. This change
reads in batches, calculates incrementally and writes to temporary files before
streaming the download.

- [Architecture and tradeoffs](ARCHITECTURE.md)
- [AI usage](AI_USAGE.md)
- [Original assignment](CANDIDATE_BRIEF.md)
- [System context](SYSTEM_CONTEXT.md)

## Setup

```bash
docker compose up --build
```

Open:

```text
http://localhost:3000
```

Postgres:

```text
localhost:5433
postgres://postgres:postgres@localhost:5433/product_health_take_home
```

Reset DB:

```bash
docker compose down -v
docker compose up --build
```

## Development and checks

Use pnpm 10.26.1 as specified in `package.json`. For local dependencies:

```bash
corepack pnpm install --frozen-lockfile
```

```bash
docker compose exec app pnpm typecheck
pnpm test
pnpm build
```

## Export resource protection

The export reads a PostgreSQL cursor in batches of 1,000 rows, carries the
unfinished product group across batches, and writes summary/raw data to temporary
files. The completed CSV is streamed to the response and temporary files are removed.

Only one export is admitted per Node.js process, including file delivery and
cleanup. Concurrent requests receive `429` with `Retry-After: 5`. This guard is
process-local and would need shared coordination for multiple app processes.

If the client disconnects, the export stops at the next cancellation check and cleans up its resources. If the file is already being downloaded, the transfer is stopped.

Exports have a two-minute time limit. Each database fetch can run for up to 30 seconds, or less if the export has less time remaining. A query already in progress may need to finish or time out before cleanup can begin. Waiting for a database connection and rolling back the transaction each have a separate five-second timeout.

If the export times out before the download starts, the API returns `504`. If the download has already started, the connection is closed and the file may be incomplete.

Unit tests use Node's built-in test runner and TypeScript stripping (Node.js
22.18+ or a newer supported release). Run `pnpm test`, or
`docker compose exec app pnpm test` using the supplied Node 22 image.
Tests call the handler directly with fake CSV/file operations; no database is needed.

### Export feedback

The Export button stays disabled while the CSV is being prepared. Cancel export
stops the preparation request; server cleanup may take a moment. When the file
is ready, the browser handles the download and the page shows a handoff message.
Use the browser Downloads panel to track or cancel the transfer after that point.
Errors such as a busy export (`429`) are displayed on the page.
