# Desk noise: handled reports, and quiet wakes of done sessions

Status: design for Odrade's night-shift goal of 2026-10-28 (Sheeana). It changes `desk.ts` and `team.ts`, and builds
on the digest (`desk-digest.md`) and the Clerk (`clerk.md`).

## 1. Why

On 2026-10-28 the Clerk escalated about 10 items that Odrade had handled already (T393, T394, T395, T401, T402). Each
time the Clerk read a report in its digest and asked Odrade to act, but Odrade had already sent the step, answered the
ask, or closed the thread with a watch result. The digest goes to the Clerk up to 15 minutes after the report, and
nothing in it says that Odrade acted in between.

Also T216: a message into the session of a closed done thread reopens the thread ("reopened: new work in its
session"). A message from the supervisor's address sets `run.quietReopen`, and the thread may close again when its
session goes idle with no report. But the thread is open in between, it shows as `silent session` in the queue, and
the digest carries it. T402 reopened this way at 19:10Z, for Odrade's own closing message.

## 2. Part 1: a handled report

**The signal.** The supervisor (a session with the role `supervisor`, not the Clerk and not an agent) acts on a thread
with 1 of these `desk` actions: `send`, `answer`, `result`, `ask`, `rewrite`, `withdraw`, `watch`. The commit of that
action records `run.handled = { at, by, act }` on the thread: `at` is the action's time, `by` the supervisor's name,
and `act` the action's name. A newer action replaces an older one; an older one never replaces a newer one.

`rewrite`, `withdraw` and `watch` are beyond the 4 actions of the goal: each is a decision about the thread's newest
report, so each counts too. An action of the Clerk does not count: the Clerk's own digest is the one to filter, and
a Clerk that acted has read the report already. A Desk-page answer by Brian does not count: it is Brian's, not
Odrade's, and it goes to the supervisor as `answer` or `answer-action`.

**Handled.** A report filed at time `t` is handled when `run.handled.at >= t`. `handledAfter(thread, t)` says so.

**The digest.** At the `take` commit, after the split, the Clerk's items of the report kinds (`report`, `shift`) whose
thread has a handled mark at or after the item's `at` leave the Clerk's list. They are taken from the box as before, so
they never come back. When nothing is left for the Clerk, the Clerk gets no message. The supervisor's own items do not
change: when there is no Clerk, she reads her reports herself.

**`desk read`.** When the newest report is handled (`handledAfter(thread, run.reportedAt)`), `desk read` shows 1 line
after the `Closed:` line: `Handled: <iso> · by <name> · desk <act> · after the newest report: no escalation for it`.

**The Clerk's rule.** The Clerk's role text in `team.ts` gets 1 sentence: a thread that `desk read` shows as `Handled`
needs no escalation for its reports, because the supervisor acted after them. `clerk.md` (section 4 and the profile
draft) says the same, so Brian can copy it into the profile.

## 3. Part 2: a quiet wake keeps a done thread closed

**Today.** The sweep reopens a closed done thread (closed in the last 7 days) when its session is busy, or a new user
entry came (`reopenReason`). A supervisor-only message sets `run.quietReopen`, and `quietSilence` lets the thread close
again later.

**New rule.** A closed done thread whose new user entries all came from the supervisor's address does not reopen. Its
session may work, and the thread stays closed, until 1 of these comes after the wake:

1. **A report:** `run.reportedAt` is later than `closed.at`. Reason: `a report after a supervisor message`.
2. **Folder work:** the thread's folder has more changed files or more unpushed commits than the thread had when it
   closed (`run.dirty`, `run.ahead`). Reason: `work in its folder after a supervisor message`. A folder that another
   open thread of any supervisor works in does not count: its work can be that thread's. The triggers run in 2 passes,
   the report triggers first, and a thread that a report opens then counts as working in its folder for the second pass.
3. **A PR:** the existing rule, `a PR it made is open`, reopens it as before.

**The mark.** The first sweep that sees a quiet wake records `run.quietWake = { at, entry }`: `at` is the sweep's time,
`entry` the session's newest user entry before the supervisor's message (`usersBefore`). It adds 1 event, key
`quiet-wake:<entry>`: `a supervisor message woke its session: it stays closed until a report, folder work or a PR`.
The triggers run in the same sweep that records the mark, and in each later sweep while the mark is there and the thread
is closed and reopenable. The sweep that records the mark starts its supervisor's sweeper in the same commit, and
`startMissingSweepers` includes a supervisor whose mark is watched, so a `desk sync` that records a wake leaves a sweeper
behind. The supervisor's sweeper stays for 24 hours after the mark (`QUIET_WATCH_MS`), also when that thread was its last
one; after that, the mark still holds the thread closed, and a later sweep still checks its triggers. A reopen for any
reason deletes the mark.

**Quiet.** A wake is quiet when `run.otherUserEntry` is known and is at or before the base entry (`quietWake.entry`, or
`usersBefore` when there is no mark yet), and `run.lastUserEntry` is after that base. A person's message, or another
session's, after the base makes it not quiet: the thread reopens as today, with today's reason, and with no
`quietReopen`.

**A busy session.** `its session is busy` alone, with no new user entry, is not quiet (a night shift, for example): it
reopens as today. With a mark, and no other message, a busy session stays closed.

**Folders.** The sweep reads the folder of each closed done thread that has a mark, or whose session is busy now.
A folder of a closed thread with a mark counts as worked: it never becomes a found-folder thread while the mark is
there.

**Stored data.** `run.quietWake` and `run.handled` are new fields. `run.quietReopen` keeps its meaning: the new code
does not set it, and `quietSilence` still closes a thread stored with it.

## 4. Tests

- Unit: `handledAfter`, `markHandled` (newer wins), the Clerk filter in the split, `readText`'s `Handled:` line,
  `quietWakeOf`, the quiet test, and each trigger (report after close, a report before the close, folder work above
  the thread's counts, folder work at the counts, a folder of another open thread).
- App: a supervisor `desk send` after a report marks it, and the Clerk's digest leaves it out; the Clerk's digest keeps
  an unhandled report. A supervisor message into a done session keeps the thread closed with the mark and 1 event; a
  report after it reopens the thread; a person's message reopens it as today.
