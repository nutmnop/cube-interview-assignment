# Architecture

## Scope and assumptions

The assignment has two goals: keep the application usable during a large export,
and describe an architecture for the whole MeterCube platform. This submission
implements the Product Health export changes. The broader module design and
future infrastructure below are proposals based on [SYSTEM_CONTEXT.md](SYSTEM_CONTEXT.md).

The application remains a Next.js monolith with one deployment. Pages and API
routes share Node.js resources. PostgreSQL supplies fixture data here; production
analytics may read from Snowflake. The starter has no queue, separate worker,
cache service or autoscaling.

Docker gives the app one CPU and 512 MiB of memory. Node.js old-space heap is
limited to 256 MiB, which is only part of the process's total memory. The supplied
container runs `pnpm dev`.

For the broader design, I assume organizations are the tenant boundary,
PostgreSQL owns account and subscription data, and entitlements restrict access
by module, country, platform and category. Actual warehouse schemas and required
data freshness need confirmation. The implemented export guard assumes one
Node.js process; it does not coordinate multiple replicas.

## Whole-system design

Keep a modular monolith initially. API handlers validate requests and delegate to
module services. Services own business rules; data-access functions own SQL and
external analytics calls. This provides clear boundaries without adding separate
services before they are needed.

| Module | Responsibilities |
| --- | --- |
| Identity and accounts | Registration, login, password reset, email verification, two-factor authentication, settings and preferences |
| Organizations and subscriptions | Memberships and module/country/platform/category entitlements |
| Market Snapshot | Country overviews, shopper metrics, GMV, market-size views and reports |
| Category Insights | Category dashboards, accuracy reports, downloads and authorized embedded dashboards |
| Digital Shelf | Product Health metrics and exports; Global Score Card trends and weekly files; Share of Search keywords, rankings and distributions; Banner Presence |
| Activity and support | Activity, notifications, feedback, guides, policy pages and maintenance status |

```text
Browser -> Next.js API -> authentication and entitlement checks
                      -> module service -> PostgreSQL / analytics adapter
```

Enforce authorization on the server for reports, exports and downloads. Requested
filters must stay within the user's organization and subscription scope; UI
filters alone are insufficient. Use parameterized queries, bounded connection
pools and server-side credentials. Embedded dashboards should receive authorized
access without exposing warehouse credentials.

Put timeouts around external analytics calls so a warehouse outage does not
prevent account or support operations. Shared export infrastructure can manage
admission, cancellation and delivery, while each module owns its calculations
and output format.

## Product Health export implementation

### Problem and approach

The original export fetched all matching rows, created additional arrays and
assembled the complete CSV in memory. Logs showed Node.js heap exhaustion before
the query returned. Receiving database results into JavaScript objects was enough
to exceed the heap limit; catching errors afterward would not protect the process.

The solution keeps the existing `pg` driver and reads through a PostgreSQL cursor:

1. Validate filters and acquire the process-local export slot.
2. Open a read-only transaction on one client and fetch 1,000 rows per batch.
3. Read in `sku_id, channel, observed_at` order. Keep totals for the current
   `skuId + channel` group across batches and finalize it when the key changes.
4. Write completed summaries and raw rows to separate temporary files, awaiting
   writes before fetching more data.
5. Close the cursor transaction, release its connection and write the final group.
6. Append raw data after the summary using chunked reads, stream the completed
   file to the client, then remove the temporary directory and release the slot.

The output retains the original calculations and layout: summary first, then
`# Raw observations` and raw data, with one header per section. Memory scales
with a batch and stream buffers rather than the complete export. A batch is a
row-count limit, however, not a fixed byte limit.

### Protecting normal traffic

Only one export runs per process, including download and cleanup. Additional
requests receive `429` and `Retry-After: 5`; they are not queued or retried
automatically. The guard is checked and acquired without an intervening `await`
and released in `finally`.

Exports have a 120-second deadline. Client disconnection signals cancellation,
which is checked between batches and file operations and passed to the download
pipeline. Each fetch has a database time limit of at most 30 seconds or the
remaining export time. Connection acquisition and rollback waits each have a
five-second timeout; a connection is discarded if rollback fails.

Cancellation is cooperative: an active query may need to finish or time out
before cleanup. The deadline is not a hard guarantee against every network or
filesystem stall. An overall timeout before headers returns `504`; after
streaming starts, it terminates the download instead.

### Tradeoffs

Temporary files avoid whole-file buffering but consume disk space and extra I/O.
During assembly, raw data exists in both files. Disk quotas and cleanup of files
left after an abrupt process termination are not implemented.

An export still shares CPU and database resources with normal requests, and the
cursor holds a transaction while reading. Admission control reduces contention
but does not isolate workloads. Multiple app processes would need shared
coordination. The UI shows preparation status and allows cancellation before the browser
takes over the download. It displays API errors, including busy responses, but
has no percentage progress or automatic retry. A short-lived readiness cookie
lets the page detect download handoff without buffering the CSV in JavaScript.

Export grouping and price-index calculation differ from the report endpoint in
the starter. This change preserves those semantics; reconciling them requires a
product/data decision.

## Future development

### Background exports

Introduce a durable job record, queue and separate worker when users need queued
exports instead of rejection. The API would return a job ID, the UI would display
status, and the worker would write completed files to object storage. Download
access would be authorized again before issuing a short-lived link.

Limit concurrency across workers, handle duplicate jobs idempotently, bound
retries and retain files for a defined period. This can serve Product Health,
Category Insights downloads and Global Score Card weekly files. It isolates
heavy work and removes the need to keep the original HTTP request open.

Initially, generate a new file per job and allow repeat downloads of that job.
Reusing old files for new requests is optional: matching filters alone does not
prove freshness. Such caching needs tenant/access scope, snapshot and calculation
versions, plus rules for late transactions and corrections.

### Analytics and operations

For repeated dashboard queries, consider aggregates or scoped caches after
agreeing freshness requirements. Monitor report latency, memory, event-loop delay,
export failures, rejections, disk usage and connection-pool pressure. Keep process
liveness separate from PostgreSQL, Snowflake and future worker health checks so
partial analytics failures do not disable unrelated features.

## Verification

Type checks, a local production build and four handler unit tests passed. Tests
cover concurrent rejection, timeout and disconnect handling. Development fixture
comparisons checked CSV compatibility, including groups crossing batches.

Under Docker's limits, a full export completed while repeated report requests
succeeded, with no container restart or reported OOM kill. Filtered exports,
concurrent rejection and interrupted requests were also checked. Results and
commands are in [README.md](README.md).

The Docker measurements precede the final handler/test readability refactor;
types, tests and build were checked afterward, but the full load run was not
repeated. These local results are not a production performance guarantee.
