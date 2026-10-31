# The Desk's Dashboard

The Desk page has 2 views: **Desk**, the operational inbox (the default each time the page opens), and **Dashboard**, the
numbers of Desk-tracked work for 1 range and 1 scope. Both are owner-only. The Dashboard only reads: it has no control
that changes a thread, and opening it starts no collection. It calls 2 routes, `GET /api/x/desk/dashboard` (the numbers)
and `GET /api/x/desk/dashboard/records` (the drill-down of 1 row). Each reads the same 2 stored documents and nothing
else (no GitHub call, no transcript read, no commit, no task).

![The Dashboard on a desktop](desk-dashboard-shots/desktop.png)

![The Dashboard on a phone](desk-dashboard-shots/phone.png)

The screenshots show the fixture of `desk-dashboard-fixture.ts` in the isolated preview (`npm run preview-desk`). The
phone one shows the bketelsen owner row with partial tokens, an unknown cost ("—"), and its open drill-down.

## The screen

- **Controls.** Owner (all tracked work, or 1 GitHub owner), repository (all, or 1 repository; it sets its owner), the
  presets 7, 30 (default) and 90 days, and a custom range (both days included, UTC). The owner and repository lists come
  from `choices` in the answer: every owner and repository with an attributed record, whatever the scope, so a choice
  never disappears when a scope is picked. All scopes share 1 range. The selections live in memory only (no browser
  storage); they stay while the module stays loaded, also across a switch to Desk and back.
- **Status line.** The snapshot time (`asOf`, UTC), the coverage status, and the count of notices.
- **Notices**, each a separate line with its own words: refresh failed (the last good numbers stay, dimmed, with their
  time), range refused (the route's 400 message; the last good numbers stay), collection not started, a stale source, a
  failed source, a source never read, usage unavailable, usage unknown or partial (the answer's `usage-unknown`
  limitation, with its words: some counted sessions have no complete read), partial coverage (the backfill goes on:
  pending refs and sessions), no tracked work in the scope (the zeros are true zeros), and no eligible closures.
- **Usage unavailable, unknown, or partial.** Each table row, the scope total, and the token and cost cards show usage
  by their own `usage.state` (`usageKnowledge` in `desk-web/dashboard.js`):
    - "—" (unknown, never 0) when the row's state is `unknown` (its counted sessions have no complete read and no valid
      entry: the route gives null sums), and in every row, the scope total included, when usage was never collected or
      its only read failed (no good read yet). The last case occurs after the first collector pass, which fixes the
      boundary before any usage step.
    - The value with "(partial)" in its text (so a screen reader says it too), such as "6,500 (partial)", when the state
      is `partial`: some counted sessions have no complete read, so the value is the known part and can be low. It
      sorts by its number; unknown sorts last.
    - The value as it is when the state is `complete`: an explicit 0 stays "0" or "$0.00". With `none` (no counted
      session) tokens are a true 0; a cost that no entry reported stays "—".
    - The cards: the token and cost cards also show the usage read (complete, partial, unknown, none) and the counted
      sessions by state ("2 complete, 1 partial, 1 unknown"). Their detail and "Apart" lines follow the same rule; the
      session counts follow only the source's availability.
    - The source: a partial usage source, and a failed one after a good read, keep their collected facts, with a notice
      that they can be low.
- **Cards**, in this order: thread completion rate, successful closures and velocity, thread cycle time, time to solve,
  current workload ("now"), tracked PRs, dated tokens, reported model cost (USD). Each card has "How is this counted?".
- **Daily trend.** The successful closures by UTC day, as bars (each with its text for screen readers), with a summary
  line and a "Daily table". The bars are 1 grid column for each day, so 1 to 366 days fit any width: the gap between
  bars is 2 px up to 31 days, 1 px up to 92 days, and 0 above that.
- **Projects.** 1 row for each repository, under its owner's subtotal row, and at the all-work scope 1 unattributed row;
  the scope total is the last row. Each column sorts (unknown values last in both directions). On a phone each row is a
  small card, with a "Sort by" control.
- **Drill-down.** Each project row, owner subtotal row, and the unattributed row has a "Threads and PRs" button
  (`aria-expanded`, `aria-controls`). It opens a row under it (1 row at a time) that reads `GET dashboard/records` for
  that row's scope and the range shown: the delivery threads the row counts (each closure in the range with its case,
  and the workload now) and its tracked PRs (each with its events in the range and its state), at most 200 of each,
  with the count left out. The read shows its loading, error, and empty states, and aborts when the row closes, the
  selection changes, or the view goes. Each new snapshot (the 60-second refresh) reads an open drill-down again: the
  list shown stays while it reads (`aria-busy`), and a failed read again keeps it, marked stale with its own time. A thread opens the Desk's own thread detail (`threads/:id`, owner-only, as on
  the Desk); its Back button ("Back to the dashboard") returns to the Dashboard with the same selection and numbers,
  the same row open, and the focus on that row's button. A thread gone from the desk shows its id and "gone from the
  desk", with no button. A PR links to its GitHub page, built from its validated repository and number.
- **Coverage and definitions.** The coverage status, the recovery boundary, the first day a range can start, the source
  table (status, last good read, last check, error), the progress counts, the population rule, the time rules, and the
  limitations that the answer lists.

"—" means unknown (a screen reader says "unknown"); "0" is a real zero. In the project table, "0 eligible" means no
eligible closure (completion) or no resolved issue (time to solve).

The view reads once when it opens, then every 60 seconds while it is mounted and the browser tab is visible. A tab that
comes back to view reads at once when the last read is older than that. Switching to Desk, closing the page, and the
module's dispose stop the timer and abort a read in flight; an answer that comes after that changes nothing.

## The drill-down route

`GET /api/x/desk/dashboard/records` (owner-only) takes the query of `GET dashboard` (`from`, `to`, `owner`, `repo`), or
`unattributed=1` with no owner and no repository (else a 400, as for a bad range). It reads `x.desk.dashboard` and
`x.desk.usage` with `request.snapshot`, as `GET dashboard` does, and nothing else: it collects nothing, calls no GitHub,
reads no transcript, commits nothing, and starts no task. `records` in `_desk-metrics.ts` groups the facts and selects
them by the same population and range rules as the numbers. The answer is `{ asOf, range, scope, threads, prs,
truncated }`:

- `threads`: each delivery thread whose latest closure has a valid time in the range (`kind`: `success`, `abandoned`,
  `failed`, `dropped`, `frozen`, or `unknown`), and each one starting, open or parked now and not gone (`kind: "now"`),
  with `id`, `repo` (or null), `state`, `closedAt`, `startedAt`, `gone`, and `prs`. No coordinator, no excluded thread.
  Sorted by id, numeric-aware.
- `prs`: each tracked PR (not untracked, not excluded) with `createdAt`, `mergedAt`, or a `CLOSED` `closedAt` in the
  range, or open now, with `ref`, `repo`, `number`, `state`, the 3 times, `events` (`created`, `merged`,
  `closed-unmerged`, `open-now`), and `threads`. Sorted by ref. The unattributed scope has none: a PR always has a
  repository.
- `truncated`: each list stops at 200 entries (`MAX_RECORDS`); `{ threads, prs }` counts the entries left out.

The all-work scope includes the unattributed threads, as its numbers do.

## Time

- All dates are UTC days. A range starts at 00:00 UTC of its first day (inclusive) and ends at 00:00 UTC after its last
  day (exclusive). A range that includes today ends at the snapshot time (`partialToday`).
- A range is 1 to 366 days. It must not start before the recovery boundary's day, and must not end after today. A preset
  never starts before the boundary's day. When the boundary falls inside the first day, events count only from the
  boundary on (`partial-first-day`).
- Outcomes are the latest known. A reopened thread leaves its range until it closes again; its latest closure counts
  once. Earlier numbers can change: this is not an immutable ledger.

## Population and attribution

- **Delivery threads.** Every delegated thread (also one whose delegation failed before a session started), and every
  found, seeded, asked, or plan thread that has a session or an attributable PR. A plan thread with task threads is a
  coordinator: its task threads count, it does not. Ask-only threads, and other threads with no session and no PR, do
  not count. Threads that left `x.desk.threads` keep their facts (`gone`).
- **Repository.** A thread belongs to its explicit `thread.repo` only. A PR belongs to the repository of its ref. An issue
  belongs to its own repository, also when its resolving PR is in another one. A session belongs to the repository of its
  explicit Desk links; a subagent conversation takes its nearest linked ancestor's. A session whose links name 2 or more
  repositories is unattributed, as a conflict.
- **Scopes.** All tracked work includes unattributed records. An owner or a repository includes only the records
  attributed to it. So project rows alone can sum lower than the total. Every rate, median and P90 of an owner row and of
  the total comes from its own raw records, never from the rows above it.

## Metrics

- **Thread completion rate.** Delivery threads whose latest closure falls in the range and that are still closed. Success:
  `why=done` with outcome `completed` or `verified`. Denominator: the successes, plus `why=done` with outcome `abandoned`,
  plus `why=failed`. Excluded and counted apart: `why=dropped` (checked first), outcome `frozen`, and no outcome
  (unknown, as on old records). A closure with no valid time is undated: it is in no range. With a denominator of 0 the
  card says "No eligible closures", never 0%.
- **Successful closures and velocity.** The successes above, and successes per week of the elapsed range: the range's
  effective start (the boundary when it is later) to its end (the snapshot time when it includes today). The daily trend
  counts the same closures.
- **Thread cycle time (median).** From the thread's `startedAt` to its latest close, for the successes in the range. A
  success with no valid start, or a start after its close, is excluded and counted. Median: the middle value, or the mean
  of the middle pair.
- **Time to solve.** From the GitHub issue's `createdAt` to the `mergedAt` of the PR that resolves it, wall clock
  (waiting and review included). Only issues linked to Desk work, each once. An issue is in the range of its resolving
  merge, not of its creation; an issue created before the recovery boundary counts when its merge is in the range. The
  median, the P90 (nearest rank: the value at rank ceil(0.9 × n) of the sorted samples), and the sample count. Open or
  reopened issues are "Unresolved now", not samples. A merge in the range with no valid duration (a missing creation
  time, or a merge before it) is excluded as invalid. Issues with no authoritative resolving PR are undated and excluded
  by reason: `not-planned`, `no-resolving-pr`, `ambiguous`, `incomplete`, `missing`, `inaccessible`, `invalid`,
  `no-resolution`, `unread`. With no sample the card says "No eligible resolved issues". This is not thread cycle time.
- **Resolution evidence.** Only the issue's latest close event gives a sample: a close by a merged PR, with that PR's
  `mergedAt` (`closed-event`). After a reopen, only the latest close counts. A manual close (no closer) or a close by a
  commit has no resolving PR (`no-resolving-pr`): earlier merged closing PRs never give a sample. When no latest close
  event is visible, the closing references cannot show the latest resolver. They only tell the reason: a merged closing
  PR makes the issue `ambiguous` (paging stops); a complete list with no merged PR is `no-resolving-pr`; pages left with
  no merged PR yet is `incomplete`. A resolution that an older rule stored from 1 closing reference
  (`closing-reference`) is no sample: each pass marks it `ambiguous` (also when a failed read, a backoff or the read
  budget delays its read), reads it again at once, and a good read judges it by this rule.
- **Current workload.** Delivery threads that are starting, open, or parked now (not gone), labeled "now": it is not the
  state at the end of the range.
- **Tracked PRs.** PRs attached to, seen by, or matched by branch to Desk threads, deduplicated by `owner/name#number` in
  any case. Created, merged, and closed unmerged count the PRs whose own GitHub time (`createdAt`, `mergedAt`,
  `closedAt` of a `CLOSED` PR) falls in the range: they overlap and do not add up. Open is the state now. Excluded and
  counted: PRs linked only by the window rule, PRs missing on GitHub, and PRs in archived repositories. Coverage gaps:
  PRs never read, PRs whose last read failed, and PRs that lack a lifecycle time their state needs. The fetch time never
  stands in for a lifecycle time. A PR read only as the resolver of an issue is not a tracked PR.
- **Dated tokens.** Input, output, cache read, cache write, and total, from the assistant entries of Desk-linked sessions
  and their subagents, by the UTC day of each request. Total is the sum of each entry's recorded total, not a sum of the
  other columns (reasoning and 1-hour cache writes are subsets, never added again). Supervisor and Clerk sessions are
  shared: never read, never counted. A session whose conversation is gone keeps its collected usage.
- **Reported model cost (USD).** The sum of each entry's recorded `cost.total`, with no repricing. It is an estimate from
  recorded usage, not an invoice or a subscription charge. An entry that reported exactly 0 counts as 0, and the card
  says that subscription or provider pricing can report 0. An entry with no cost is unknown: a scope where no entry
  reported a cost shows "—", not $0.00.
- **Apart from the range totals.** Usage with no valid date (`undated`), and the settled compaction residual: the
  difference between a session's `pi.usage` ledger and the sum of its own entries (compaction summaries have no entry and
  no date). Both show on the token and cost cards as "Apart", never in a range total and never spread over days. The
  residual has its own knowledge (`residualKnowledge`): it shows whenever a counted session has a settled residual, also
  when the dated usage is unknown; it is "(partial)" when a counted session has a residual mismatch or a ledger that
  could not be read, and "—" when no counted session has a settled residual or the usage source has no good read.

## Collection and backfill

A collector task (`x.desk.dashboard-collector`, 1 for the app) starts from a desk sweep or `desk sync`. It never starts
an agent and never sends a message. Each pass:

1. reads `x.desk.threads` (never writes it) and the stored facts;
2. runs the usage step: at most 10 pages (`MAX_SESSION_PAGES`), each page at most 200 entries (`ENTRY_PAGE`) or 100 child
   conversations (`CHILD_PAGE`), each page in its own commit, then at most 50 ledger checks (`MAX_LEDGER_CHECKS`);
3. makes at most 1 GitHub GraphQL call with at most 20 ref reads (`MAX_REF_READS`): PR reads, issue reads, and pages of an
   issue's closing references (25 each, at most 4 pages, `MAX_CLOSING_PAGES`) share that budget;
4. writes what changed in 1 commit, then sleeps 5 minutes (`PASS_MS`). A new collector also waits 5 minutes first.

- **Recovery boundary.** The first pass fixes it at 90 days before that pass (`BOUNDARY_DAYS`). It never moves. Usage
  before it is kept only for the ledger check; ranges cannot start before its day.
- **Refresh.** An open PR or issue is read again after 30 minutes, a closed-unmerged PR or a closed issue after 24 hours,
  a failed read after 15 minutes; a merged PR with all its times is not read again. A linked session's entries are read
  again at least every 6 hours, and its child conversations every 24 hours.
- **Failures.** A failed read keeps every fact and marks its source. A rate limit (or fewer than 100 points left) stops
  GitHub reads until the reset, or for 15 minutes (`backoffUntil`).
- **Source status** (`sourceView` and `githubView` in `_desk-metrics.ts`), checked in this order: `never` (no read yet),
  `failed` (the last read failed), then `stale`, then `partial`, else `ok`. `STALE_MS` is 75 minutes: the 1-hour
  heartbeat plus 3 passes.
    - **Desk threads and usage.** Stale when the last check, `checkedAt` (else `lastGoodAt`), is older than `STALE_MS`,
      or absent. A pass with no change still writes `checkedAt` at most once an hour (the heartbeat), so a quiet source
      stays fresh. Partial when the source lists partial refs, is not complete, or failed in part. Usage is also partial
      when a counted session has malformed entries, a residual mismatch, or a ledger that could not be read.
    - **GitHub.** It writes no heartbeat when no read is due, so its age alone never makes it stale. It is stale when the
      threads source is stale or never read (1 pass reads both), or when a tracked ref is overdue: its next read, by the
      collector's own refresh rules and the stored facts, is due by more than `STALE_MS`. During a backoff that has not
      ended, overdue refs do not count, and the status is at least partial. It is also partial when the source lists
      partial refs or is not complete.
    - **GitHub `partial` and `complete`** come from the whole stored state, not from the last answer only. `partial`
      lists each ref with a stored read error, each ref of the last answer with an error in its part (also a deeper
      error beside good data), and each earlier entry until a clean read of it. All 3 take only a tracked ref, and a PR
      only when it is not excluded: a missing or archived PR is no coverage gap, so it never enters the list. A failure
      of the whole read keeps the list. A ref that becomes untracked or excluded leaves it.
      `complete` is true only when every tracked PR is excluded or read with no gap and no error, every tracked issue is
      read with no gap, no error, and is not `incomplete` (for example at the closing page limit), and `partial` is
      empty.

## Source gaps

- **Undated usage and compaction.** Usage with no valid date, and compaction usage that only the cumulative ledger holds,
  cannot go into a day. They show apart. A residual that does not settle (a ledger lower than the entries) is a mismatch,
  and a ledger that cannot be read is unavailable: both make the usage source partial (`usage-gaps`).
- **Unknown cost.** Entries with no valid cost stay unknown; their count is on the cost card.
- **Unattributed and conflicting sessions.** Sessions with no repository, or with 2 or more, count only at the all-work
  scope, in the unattributed row, with their counts on the token card.
- **History.** The last 50 thread events are not a history, and the collector does not rebuild one. Closures before the
  boundary, missing sessions, and absent PR or issue times stay visible gaps; nothing is invented.

## Version-sensitive parts

The dashboard uses Pi Durable's committed document and entry APIs at the CI-pinned Pocket version: `tx.conversation`,
`tx.scanEntries`, `tx.scanConversations` (child conversations by owner), the `pi.assistant` entry kind, and the
`pi.usage` ledger (`UsageDoc`). It reads no SQLite file and no private route. A failed child discovery or entry page
marks that session with its error, and the usage source stays incomplete; a ledger that cannot be read makes the residual
`unavailable`. The screen shows these as partial coverage and in the source table. The operational Desk reads Pocket's
`pocket.subagents` document to see whether a subagent works; the dashboard does not depend on it.

## Storage growth

- `x.desk.dashboard` holds 1 fact for each desk thread (kept after the thread leaves the desk, with `goneAt`), each
  tracked PR, and each tracked issue (with at most 100 merged closing references). Facts for refs that no thread links any
  more stay, marked `untracked`. Nothing is pruned. It grows with the number of threads, PRs and issues the desk ever
  tracked: a few hundred bytes each.
- `x.desk.usage` holds 1 record for each linked session and each child conversation found under one, with counters by
  UTC day and model for days at or after the boundary, 1 counter set before it, 1 undated set, the ledger, and the
  residual. Nothing is pruned. It grows with sessions × active days × models.
- Both documents checkpoint after 64 changes. A pass with no change writes nothing, except a heartbeat at most once an
  hour.

## If the numbers look wrong

There is no automatic purge, and the dashboard never changes `x.desk.threads`. To check:

1. Read the notices and the "Coverage and definitions" section: a stale, failed or partial source, pending refs or
   sessions, and the limitations explain most gaps. Wait for the backfill to finish.
2. Compare 1 scope and range with the facts: `GET /api/x/desk/dashboard?from=…&to=…&repo=…` gives the same answer as JSON,
   with every count that the screen shows. `GET /api/x/desk/dashboard/records` with the same query (or
   `unattributed=1`, alone) lists the threads and PRs behind those counts.

A reset, when one is ever needed, must keep the operational desk: only `x.desk.dashboard` and `x.desk.usage` are the
dashboard's, and both are rebuilt from `x.desk.threads`, GitHub, and the sessions. A reset would clear those 2
documents only (Brian's decision and step, with the module off): the next collector then fixes a new recovery boundary 90
days before its first pass, and history before it is gone for good. No tool or route in this module does this.

## Tests

`desk-metrics.test.ts` covers the reducers, `records` (each closure kind, the workload now, gone, excluded and
coordinator threads, PR events, the scopes, the cap and `truncated`), both routes (owner-only, the 400s, and no `gh`
call, no document change and no task during a GET), and `choices`. `desk-dashboard-web.test.ts` runs `snapshot()` and
`records()` on the preview fixture (its rows hold complete usage with an explicit $0.00, partial usage, and unknown
usage) and checks the exact numbers and words the screen shows, with the page's own helpers. `desk-web.test.js` covers
the page's helpers: formats (unknown versus 0), the query path, the scope choices, sorting, the table rows, the usage
knowledge of each row (`usageKnowledge`, `usageText`, `usageReadLines`), the residual's own knowledge
(`residualKnowledge`), the states, the drill-down helpers (`recordsPath`, `prUrl`, the words, and `recordsStep` and
`useRecords`: an open drill-down reads again for each new snapshot), and the default view.
