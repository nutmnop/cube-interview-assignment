# AI Usage

## How I used AI

I used OpenAI Codex to investigate the export failure, discuss implementation
options, review my code and help implement the solution. AI wrote substantial
parts of the export changes, tests and documentation.

The assistance covered:

- Interpreting the heap-out-of-memory logs and identifying whole-result buffering.
- Explaining PostgreSQL cursors, async generators, connection cleanup and
  calculations that continue across batch boundaries.
- Implementing incremental CSV generation, temporary-file cleanup and streaming.
- Adding the export concurrency guard, disconnect cancellation and time limits.
- Adding preparation feedback, a cancel button and browser download handoff.
- Running checks and drafting the architecture and README.
- Simplifying the handler tests to use explicit dependencies instead of loading
  source code through a custom `vm` harness.

## Initial investigation

I first tried limiting the query to 1,000 rows and confirmed that a smaller export
could download. I investigated the query stage with memory checkpoints and shared
logs showing that Node.js exhausted its heap before the query returned.

## Ideas I contributed

I helped shape the solution through experiments and design questions, rather than
only asking AI to fix the export:

- I wanted to separate the query stage from the calculation and CSV stages to
  identify where the memory failure occurred.
- I proposed reading 1,001 rows for a 1,000-row batch to detect whether more data
  remained, and raised the need for stable ordering. This was an explored option,
  not the final implementation. AI suggested a database cursor as an alternative.
- I pointed out that a batch could end in the middle of data needed for a product
  calculation. We worked through retaining the unfinished group's totals and
  writing only completed groups before reading more data.
- I questioned whether CSV generation could still exhaust memory after batching.
  After discussing incremental writes, I proposed preparing a temporary file
  completely before handing it to the user. AI helped implement that flow while
  preserving the summary and raw sections.

I then wrote an initial cursor implementation and asked for review. I also
reverted an earlier AI version to try the approach myself before asking for help
completing it. Later, I requested loading feedback and proposed a manual stop
button so users could see and cancel export preparation.

## Review and manual testing

My review focused on the query-to-CSV flow, the cursor's connection lifecycle,
carrying unfinished groups across batches, and preserving both the calculated
summary and raw observations. I asked for explanations of the concurrency guard,
connection timeout, cancellation and test setup, and requested simpler code where
I found the implementation difficult to follow.

I manually tested the application in Docker:

- A full-dataset export downloaded successfully.
- A second export requested while the first was still running returned `429`.

These manual checks do not represent a row-by-row audit of the complete export.

## Checks performed by the agent

Codex ran TypeScript checks, a local production build and handler unit tests.
The current tests call `createExportHandler` with fake CSV/file operations and a
separate state object for each test. They cover concurrent rejection through
cleanup, timeout and client disconnection. The timeout test uses a real timer
with a 10 ms limit. They do not connect to PostgreSQL.

During development, Codex also compared CSV output with the original code using
empty, single-row and 2,505-row fixtures, including a group crossing batches.
A Docker integration run checked a full export alongside report requests,
filtered export, concurrent rejection, interrupted requests, slot reuse and
temporary-file cleanup. Measurements are recorded in [README.md](README.md).
The development-only integration script was removed from the submission; the
handler unit tests remain. The Docker measurements were taken before the final
handler/test readability refactor; subsequent checks covered types, unit tests
and build, not another full Docker load run.

## Scope and responsibility

The queue, background worker, object storage and caching described in
[ARCHITECTURE.md](ARCHITECTURE.md) are future options, not implemented features.

I am responsible for the submitted work. This document distinguishes my manual
investigation and testing from AI-written code and agent-executed checks.
Disk-full and network-failure injection were not tested, and the local Docker
results are not a production performance guarantee.
