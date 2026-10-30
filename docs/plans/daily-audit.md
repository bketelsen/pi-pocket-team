# Daily audit of pi-pocket-team operations: design

Status: design, decided by Brian on 2026-10-23 (desk thread T108, asks T108a and T108b; Section 11).
Nothing here is installed or turned on.

The daily audit reads one day of the team's work and gives Brian at most 5 small proposals, each
backed by facts. It reads, counts and compares. It never changes anything. Mechanical checks do the
work; an LLM only writes the short text and decides the few cases that need judgement.

A first manual run of the deterministic part, over the last 72 hours, is in
[Appendix A](#appendix-a-trial-run-2026-10-23-72-hours). It found every friction case in the brief
but one, and it corrected 3 of them. The trial script is
[`daily-audit/trial.mjs`](daily-audit/trial.mjs).

## 1. Scope

The pipeline, as the audit sees it:

| Part                   | What the audit looks at                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Team drop-in           | `team_delegate` calls and refusals, identities, the roster's repositories                                                        |
| Desk module            | threads, events, sweeps, cap, asks, watches, close-out and repair wake-ups, attributions                                         |
| Night and day shifts   | `x.night-shift.goal`: rounds, verdicts, stop reasons, workers                                                                    |
| Linked-session traffic | `team_message` and `team` results, filed reports, the queue continues to Odrade                                                  |
| Schedules              | `pocket.schedule` tasks and their outcomes                                                                                       |
| GitHub                 | PRs by `frostyard-machines`: states, checks, merges, head branches left after a merge                                            |
| Odrade's notes         | `~/agents/odrade` when that folder exists, else `~/projects/odrade`: the desk (git), `README.md` index, `decisions/`, `reports/` |
| Agents' homes          | `~/agents/<id>/`: each git folder but Odrade's, its uncommitted files and its last commit                                        |
| Spend                  | model cost per agent and per thread, and the cost of turns that did no work                                                      |

## 2. Rules

1. **Read-only, always.** The database opens with `readOnly: true`. `gh` gets only `GET` requests
   and GraphQL queries (the script refuses a query that holds `mutation`). `git` gets only `log`, `status` and `show`, and every call sets `core.hooksPath=/dev/null` and `core.fsmonitor=false`: a read never runs a program that a repository names. The audit never calls a Pocket route that writes, never uses `desk`,
   `team_message`, `team_delegate` or `schedule`, and never commits.
2. **A fact or nothing.** Each finding has a check id, a count, the times, and evidence a person can
   open: a desk file (`desk/T36.md`), a GitHub URL, or an entry id. A proposal cites finding ids.
3. **Deterministic first.** A check is code with a threshold. The LLM gets only what code cannot
   decide (Section 5), and its answer is checked by code before anyone sees it.
4. **Already fixed is not a proposal.** When the last case of a finding is older than the live
   module's install time plus 1 sweep (10 minutes), the report lists it under "maybe fixed", not as
   a proposal (the trial marks this `afterInstall: false`). An install less than 1 h before the
   run proves nothing yet: the finding keeps its rank, marked "installed recently".
5. **No secrets.** The report never holds report bodies, prompts, tokens, environment values or
   file contents. A quote is at most 80 characters, and passes a redaction filter (`ghp_`,
   `github_pat_`, `sk-`, `AKIA`, `-----BEGIN`, `password=`, `token=`); a quote that matches is
   dropped, not masked.

## 3. Data sources

| Source                                                               | How it is read                                                                                                                                            | Notes                                                                                                                                                                                     |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.pi-pocket/pocket.sqlite`                                         | `node:sqlite`, `readOnly: true`; a document is its last `base` revision plus each `delta` (`@earendil-works/chord/delta` `apply`), as Pi Durable folds it | Not public API: a Pocket upgrade can change it. Each check that cannot read its source says "source unavailable" and is skipped; the run does not fail.                                   |
| `x.desk.threads` deltas                                              | every `events` insert, not only the last 50 a thread keeps                                                                                                | The full event history since the desk started (2026-10-22 00:50Z).                                                                                                                        |
| `x.desk.reports` deltas                                              | every report, not only the last 10 a session keeps                                                                                                        | Report text is read to compare, never copied out.                                                                                                                                         |
| `entries` (transcripts)                                              | fixed patterns only: `Desk queue:` user entries, tool results with `isError`, `usage.cost.total`                                                          | No free reading of transcripts by the LLM.                                                                                                                                                |
| `x.night-shift.goal`, `x.team.identity`, `tasks` (`pocket.schedule`) | materialized documents and task records                                                                                                                   |                                                                                                                                                                                           |
| `~/agents/odrade`, else `~/projects/odrade`                          | `git log`, `git status --porcelain`, the file list of `reports/`, `README.md`                                                                             | Odrade's folder; read. The audit writes only its own report folder there (Section 7). `ODRADE_DIR` names another one.                                                                     |
| `~/agents/<id>/`                                                     | `git log`, `git status --porcelain`                                                                                                                       | Each agent's home: a local git repository, no remote. `TEAM_HOMES_DIR` names another root; a folder that does not exist gives no homes and no error. Odrade's home is left out (group I). |
| GitHub                                                               | `gh search prs --author frostyard-machines`, 1 GraphQL query per 40 PRs, check runs of each repair's commit, `repos/:r` for settings                      | About 10 to 20 calls a day.                                                                                                                                                               |
| `~/.pi-pocket/extensions/*.ts`                                       | file modification time only                                                                                                                               | The install time for rule 4.                                                                                                                                                              |

## 4. Checks

`D` = deterministic. `D+L` = deterministic candidates, and the LLM decides each one (Section 5).
The thresholds are the ones the trial used; 2 of them changed after the trial showed false
positives (marked †).

### A. Desk lifecycle

| Id  | Check                                                                                                                                                                                                                                                                                                                                                            | Kind | A finding when                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------- |
| A1  | Reopen churn. Count `reopened:` events per thread. For each reopen, classify the user entry that began the turn (supervisor: muster gather, review task, after-merge step, new task; another agent; a schedule; a person). An **empty reopen** has no PR, ask, branch, dirty or shift event before the next close; its cost is the session's spend in that span. | D    | a thread reopens 2 or more times in 24 h (high at 4)                                    |
| A2  | Queue churn. Parse each `Desk queue:` continue in a supervisor session into (thread, reason). A "silent session" item is **for done work** when the thread's next event (other than busy, idle and reports) is its close. Cost: the supervisor's spend until its next user entry.                                                                                | D    | a thread is in the queue 3 or more times in the window (high at 6)                      |
| A3  | Close-out wake-ups per thread.                                                                                                                                                                                                                                                                                                                                   | D    | 3 or more on one thread                                                                 |
| A4  | Repeated tool errors of `desk`, `team`, `team_delegate`, `team_message`, `team_sessions`, grouped by message (thread ids masked).                                                                                                                                                                                                                                | D    | the same message 2 or more times                                                        |
| A5  | Threads closed `failed`, found threads (`F…`) and how long each stayed found, `The desk is full` refusals and OKs used, asks open longer than 24 h, watches due without a result.                                                                                                                                                                                | D    | any `failed`; a found thread older than 24 h; any refusal; a due watch older than 1 day |

### B. Repair wake-ups

| Id  | Check                                                                                                                                                                                                                                                                                                                           | Kind | A finding when                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------ |
| B1  | For each `run.repairs` key `repair:<ref>:<oid>:FAILURE`, read every check run of `<oid>` (`filter=all`). Only the runs that completed by the wake-up count: a check name fails when one of them ended `failure`, `timed_out` or `action_required`, and no success completed after it. `cancelled` and `skipped` are not faults. | D    | a repair went out and no check name failed |
| B2  | Agent replies to a repair that say the PR does not fail (regex: `does not fail`, `not failing`, `only "?cancelled`).                                                                                                                                                                                                            | D    | 1 or more                                  |

### C. Attribution

| Id  | Check                                                                                                                                   | Kind | A finding when                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------ |
| C1  | PRs attached by the `window` rule, and whether a later `detached <ref>` followed (with the thread it went to). Also the count by `via`. | D    | a window attach that was moved |

### D. The desk against GitHub

| Id  | Check                                                                                                                                           | Kind | A finding when                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------- |
| D1† | An ask answered `merged…`: the time from the answer to GitHub's `mergedAt` for each PR ref in the ask (the median and the maximum are metrics). | D    | not merged, or merged 15 min or more after the answer               |
| D1b | After a `merged` answer, a new ask on the same thread about the same PR in the next 10 min, while GitHub had not merged it yet.                 | D    | 1 or more (an ask Brian did not need)                               |
| D2  | Each attached PR's state on an open thread against GitHub now.                                                                                  | D    | the desk differs, and GitHub changed before the thread's last sweep |

### E. Reports and messaging

| Id  | Check                                                                                                                                                                                                                           | Kind | A finding when                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------ |
| E1† | 2 reports on one thread within 30 min: word-set overlap (Jaccard on words of 3 or more characters) and the set of `#n` refs in each.                                                                                            | D+L  | sure: 80% or more and the same refs. 50 to 80%, or different refs: a candidate for the LLM |
| E2  | `team_message` or `team` calls that failed (`No linked session has that address here`, the side-door block).                                                                                                                    | D    | any address failure (medium); 2 or more blocks (low)                                       |
| E3  | A night shift's report and a `team_message` from the same session within 30 min, with no new request from a person or another agent to that session between the 2 (a `team_message` that answers such a request is not a twin). | D+L  | 3 or more pairs in the window; the LLM samples up to 5 pairs: same result or not           |

### F. Night and day shifts

| Id  | Check                                                                                                                                                                                                                                                    | Kind | A finding when                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------- |
| F1  | Shift endings by reason (`done`, `blocked`, `error`, `max rounds`, `deadline`, `person`) and the `why`.                                                                                                                                                  | D    | any `error` or `max rounds`; each `blocked` is listed |
| F2  | Rounds that follow a `continue` verdict in under 60 s (the agent waits on a subagent and burns a round).                                                                                                                                                 | D    | 2 or more shifts with 2 or more such rounds           |
| F3  | A worker that is not the one the brief named (the cross-review reviewer, with exactly the tools `read` and `bash` and "review" in its name or brief, is not one), and a DeepSeek worker that starts in its peak (01:00 to 04:00 and 06:00 to 10:00 UTC). | D    | any                                                   |

### G. Schedules

| Id  | Check                                                                                                  | Kind | A finding when         |
| --- | ------------------------------------------------------------------------------------------------------ | ---- | ---------------------- |
| G1  | `pocket.schedule` task outcomes (`completed`, `aborted`, `failed`), and a schedule more than 1 h late. | D    | any `failed`; any late |

### H. GitHub

| Id  | Check                                                                                                                      | Kind | A finding when              |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------- |
| H1  | Merged bot PRs whose head branch still exists 1 h after the merge, and each repository's `delete_branch_on_merge`.         | D    | 1 or more (medium at 5)     |
| H2  | Bot PRs on no desk thread.                                                                                                 | D    | 1 or more                   |
| H3  | Bot PRs with a commit whose check rollup is `FAILURE` or `ERROR` (first-pass CI), and open bot PRs with no event for 48 h. | D    | rate above 20%; any idle PR |

### I. Odrade's notes

| Id  | Check                                                                                                                                                                                                                        | Kind | A finding when                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------ |
| I1  | `reports/*` folders that `README.md` does not link.                                                                                                                                                                          | D    | 1 or more                      |
| I2  | Uncommitted files in the desk repository, and the time since the last commit (the digests are at 07:30 and 20:00).                                                                                                           | D    | uncommitted for more than 13 h |
| I3  | Each agent's home (`~/agents/<id>/`, Odrade's left out): uncommitted files, and the time since the last commit. The agent commits its home at the end of each task. 1 finding for each such home. Metrics: `homes`, `dirty`. | D    | uncommitted for more than 24 h |

### J. Spend

| Id  | Check                                                                                                                                        | Kind | A finding when                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------ |
| J1  | Spend per day, per agent, per thread (`usage.cost.total` of assistant entries); the spend of empty reopens (A1) and of queue continues (A2). | D    | a day 50% above the 7-day median; waste above $5 a day |

### R. Model routing (shadow)

| Id  | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Kind | A finding when                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------ |
| R1  | Every desk thread with a `route` (the model router's shadow record), in no time window, grouped by the kind, the suggested tier, the suggested model, the status, the named worker (`named`: the route's `worker`, `-` when none) and the model that really ran (the night-shift goal's `worker`, else the thread session's most common subagent model, cross-review reviewers left out): count, open, success (closed as done, completed or verified), not success, the goals' statuses, the median rounds, the median cost of the session, and the reopenings. A success rate shows only for 10 threads or more. The metric `named` covers the shadow routes that have a `worker`: `{ routes, same, differs }`, where `same` is the routes whose suggested model is the named worker and `differs` the rest, each as `{ count, open, success, notSuccess, suggestionRan }` (`suggestionRan`: the suggestion is also the model that ran). | D    | never: metrics only (`routes`, `cells`, `named`) |

## 5. Where the LLM is needed, and nowhere else

1. **Same facts or not** (E1 candidates, E3 samples): at most 10 pairs a day. Input: the 2 report
   texts, each cut to 1,500 characters. Output: `same | different | partial`, 1 line why. Code
   counts the answers.
2. **Writing the proposals.** Code ranks the findings (below) and gives the top 12, with their
   metrics, to the LLM. The LLM groups them into at most 5 proposals and writes each one. It never
   sees a transcript.
3. **Code checks the LLM's text** before anyone sees it: at most 5 proposals; each cites 1 or more
   finding ids that exist; each number in its text appears in a cited finding or metric; the owner
   and the size come from the fixed table below, not from the model. A text that fails goes out as
   the plain ranked list, with no LLM text.

**Rank** (deterministic): `weight(severity) × (1 + log2(cases)) + days it repeats + waste in $ / 5`,
with weight high 3, medium 2, low 1. A finding marked "maybe fixed" (rule 4) gets no rank.

**Owner and size** (fixed table, by check):

| Checks                | Component                                     | Owner                          | Typical size              |
| --------------------- | --------------------------------------------- | ------------------------------ | ------------------------- |
| A1–A5, B, C, D, E1–E2 | `desk.ts` (rule) or Odrade's workflow (habit) | Sheeana (code), Odrade (habit) | S: 1 rule and its test    |
| E3, F                 | `night-shift.ts`, or the brief template       | Sheeana, Odrade                | S                         |
| G                     | Pocket schedules                              | Odrade                         | S                         |
| H1                    | repository settings                           | Brian (settings stay his)      | S: 1 click per repository |
| H2, H3                | agents' briefs and CI                         | Odrade, the repository's owner | S–M                       |
| I1–I2                 | Odrade's notes                                | Odrade                         | S                         |
| I3                    | the agents' homes                             | each agent (its own home)      | S                         |
| J                     | models and briefs                             | Brian decides, Odrade proposes | M                         |

## 6. Output

One short Markdown report a day, plus the JSON it came from. A proposal has the facts, the
evidence links, the size, and the owner. The report fits on a phone screen:

```markdown
# Audit 2026-10-24 (24 h to 06:30)

Spend $391 · 23 threads · 41 PRs (38 merged) · 0 failed shifts

## Proposals

1. **Do not reopen a done thread for a supervisor's new message** (desk.ts, Sheeana, S)
   47 reopens, 40 from Odrade's messages (12 muster gathers, 16 new tasks); 31 did no work ($16.19).
   T36 reopened 10 times. Evidence: desk/T36.md, desk/T53.md, desk/T16.md. [A1:T36, A1:T53, A1:T16]

## Maybe fixed

- A2:T11 (last case 01:17Z; desk.ts installed 01:12Z)

## Gone since yesterday · New today · Repeating 3+ days

- …
```

The JSON keeps every finding, so the next day can say what is new, what repeats, and what is gone.

The report also names the audit's own code version, in the line `Audit code: <commit> (<date>).`
(or `Audit code: unknown.`), so a finding can be traced to the code that made it.

## 7. Where it runs, when, and on which model

**Decided: a script and a Pocket schedule.**

- The script `audit/daily.mjs` in this repository (the trial script, cleaned up, with tests on
  fixtures in the style of `PI_POCKET_TEAM_AGENTS`). It writes the day's JSON to
  `/var/home/bjk/projects/odrade/reports/YYYY-MM-DD-daily-audit/findings.json`, and the day before's
  JSON is read from the same place for "new, repeating, gone". It is not a drop-in: it adds nothing
  to the running server, and no restart or module switch is needed.
- 1 dedicated session, "Daily audit", with 1 Pocket schedule: `every day 6:30`
  (America/New_York: 10:30 UTC, outside DeepSeek's peak window, and 1 hour before Odrade's 07:30
  brief). The scheduled message tells Pi to run `npm run audit` and end with 1 line. The script
  writes the report to `/var/home/bjk/projects/odrade/reports/YYYY-MM-DD-daily-audit/README.md`.
- Model: `deepseek/deepseek-flash` for the LLM steps (T108b). The script makes the 1 model call
  itself, through Pi's model runtime and Pi's stored DeepSeek sign-in, so the limits of Section 8
  are in code (`audit/llm.mjs`), not in a prompt. The session itself only runs the script; it can
  run on any model, and DeepSeek Flash keeps it cheap.
- The audit writes only that folder. It does not commit it, and it does not edit Odrade's
  `README.md` index: Odrade commits the folder with her digest.
- Odrade reads the day's report and brings its proposals to Brian in the 07:30 brief; she files
  what he must decide as desk asks. The audit never files an ask itself.

Rejected for now:

- **A drop-in module with a durable task.** It runs inside the server everyone uses, and it needs
  the restart-safe rules of Night shift. The audit needs neither: it only reads.
- **A plain systemd timer.** It works for the deterministic part, but its output is outside
  Pocket, and the LLM step still needs a session.

## 8. Cost limits

| Part          | Limit                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic | 0 model tokens; at most 40 GitHub calls (the trial used about 15); under 2 minutes (the trial took about 25 s)                    |
| LLM           | 1 call a day; input at most 30,000 tokens (the script cuts the findings to fit); output at most 2,000 tokens; at most $0.50 a day |
| Over a limit  | The script sends less (fewer findings, no pair checks). After 2 days over $0.50, the run is deterministic only.                   |

For scale: the team spent about $1,162 in the trial's 72 hours. The audit's limit is under 0.2% of
that.

## 9. What it must never do

- Change the server, a setting, a module, a schedule, the desk, a thread, an ask, or any data.
- Restart Pocket, or turn a module on or off.
- Write to GitHub: no comment, label, review, merge, branch delete or setting.
- Write outside its day's folder `odrade/reports/YYYY-MM-DD-daily-audit/`; write in any
  repository; commit or push.
- Send a message to an agent or to Odrade; file a desk ask.
- Put secrets, tokens, environment values, prompts or full report texts in its report.
- Read a transcript with the LLM, or let the LLM pick a model, an owner or a size.

## 10. Roll-out

1. Brian decided the open points on 2026-10-23 (Section 11).
2. A PR turns the trial into `audit/daily.mjs` with fixture tests (`npm test`), and adds the
   missing checks (A5, B2, F3, G1 late, H3 idle, I2, J1 baseline).
3. Brian makes the session and the schedule (or tells Odrade to). 1 week of reports, then he
   decides whether to keep it, and whether the thresholds stay.

## 11. Brian's decisions (2026-10-23)

1. **Where the report goes (T108a):** Odrade's folder,
   `/var/home/bjk/projects/odrade/reports/YYYY-MM-DD-daily-audit/README.md`, with
   `findings.json` beside it.
2. **The model and the time (T108b):** the LLM steps run on `deepseek/deepseek-flash`, daily at
   06:30 EDT (10:30 UTC, outside DeepSeek's peak window).
3. **Owners:** Sheeana owns the code and the thresholds. Odrade reads the report and brings the
   proposals to Brian in the 07:30 brief.
4. **T108c (branch cleanup):** done on 2026-10-23. The bot deleted the 36 head branches of merged
   bot PRs from the trial (check H1). The setting "Automatically delete head branches" stays
   Brian's; his commands are in Odrade's `reports/2026-10-23-daily-audit/branch-cleanup.md`.

## Appendix A: trial run 2026-10-23 (72 hours)

The deterministic part, run by hand: `node docs/plans/daily-audit/trial.mjs --hours 72`, from
2026-10-20 15:38Z to 2026-10-23 15:38Z. The desk started on 2026-10-22 00:50Z, so the desk checks
cover about 39 hours. The run took about 25 seconds and about 15 GitHub calls, and wrote nothing.
Live modules: `desk.ts` installed 2026-10-23 01:12Z (with PR #26), `team.ts` 00:30Z,
`night-shift.ts` 00:27Z.

### The numbers

| Metric                                      | Value                                                                                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reopens                                     | 47 (27 "new work in its session", 18 "its session is busy", 2 other)                                                                               |
| What began the reopening turn               | Odrade: 16 new tasks or questions, 12 muster gathers, 6 review tasks, 6 after-merge steps; 3 the agent's own schedule; 2 another agent; 2 a person |
| Empty reopens (no PR, ask, branch or shift) | 31 of 47, $16.19 of model spend                                                                                                                    |
| Odrade's queue continues                    | 41 continues, 44 items; 17 "silent session" items were for work already done; $9.62                                                                |
| Close-out wake-ups                          | 42 on 29 threads                                                                                                                                   |
| Repair wake-ups                             | 6; 2 for a PR with no failing check                                                                                                                |
| Attributions by `via`                       | 98 seen, 57 attached by hand, 3 branch, 1 window (2 window attaches; 1 moved)                                                                      |
| `merged` answers checked against GitHub     | 65: 58 merged before the answer, 7 after (median −23 s, max 503 s); 0 never merged                                                                 |
| Desk state against GitHub now               | 0 differences                                                                                                                                      |
| Reports filed                               | 275 (246 `team_message`, 29 night shift); 1 sure duplicate, 4 candidates for the LLM                                                               |
| Night shift report + `team_message` pairs   | 16 of 29 night shift reports                                                                                                                       |
| Messaging failures                          | 2 "No linked session has that address here", 4 side-door blocks                                                                                    |
| Shift endings                               | 44 done, 4 blocked, 1 paused by a person, 1 running; 11 rounds came under 60 s after a `continue`                                                  |
| Schedule tasks                              | 23 completed, 34 aborted (cancelled one-shot checks), 6 running, 0 failed                                                                          |
| Bot PRs (`frostyard-machines`)              | 118: 109 merged, 9 open; 6 had a failing commit; 9 on no desk thread                                                                               |
| Merged bot PRs with the head branch left    | 36, in 11 repositories that all have "delete head branches" off                                                                                    |
| Odrade's reports not in her `README.md`     | 6 of 42                                                                                                                                            |
| Model spend                                 | about $1,162: Odrade $432, Irulan $197, Sheeana $99, Murbella $97, Lucilla $81, Tamalane $73, Teg $51, others $133                                 |

### The brief's friction list, checked

| Case in the brief                                                                   | Result            | What the data says                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repair wake-ups for PRs that did not fail (updex#457), 3 "it does not fail" reports | Confirmed, 2      | B1: 2 repair wake-ups for updex#457, at `33951d8` (13:29Z) and `81bef52` (13:39Z). At each commit, "Conventional PR title" has 1 `success` and 1 `cancelled` run. `desk.ts` counts `CANCELLED` as failed (`FAILED_RUN`). T95 holds 2 "does not fail" reports, not 3.      |
| T36 reopened 3 times; "silent session" items for done threads                       | Confirmed, larger | A1: T36 reopened 10 times in 24 h; the last case is after the install. 40 of the 47 reopens began with a new message from Odrade into the done session. A2: 17 of 44 queue items were for work already done; T53 was in the queue 9 times in 16 min.                      |
| homebrew-tap#8 on T67 by the window rule                                            | Confirmed         | C1: attached to T67 (window) at 10:07Z; Odrade moved it to T53 at 13:40Z. 1 of the 2 window attaches in the window was wrong.                                                                                                                                             |
| A session cannot reach Odrade's address; the report went another way                | Confirmed         | E2: T36 (Murbella), 13:27Z, `team_message`: "No linked session has that address here". The address came from another session's message. The next report on T36 begins "For Odrade (address session-1c5a050c is not reachable from here)".                                 |
| A merge reported as "merged" while the PR was still OPEN (updex#457)                | Not a desk fault  | D1b: Brian answered T95d "merged" at 13:44:02Z; GitHub merged at 13:45:07Z (64 s later). Odrade checked in between and filed T95e. Of 65 `merged` answers, 7 came before GitHub's merge (at most 503 s). The desk never showed MERGED for an open PR (D2: 0).             |
| Duplicate reports (night shift report plus `team_message`)                          | Confirmed, larger | E3: 16 of 29 night shift reports have a `team_message` from the same session within 30 min. Word overlap is low (17 to 24%), because the night shift adds its own frame, so the LLM step decides "same facts". E1: 1 sure duplicate (T16, the same text twice at 23:41Z). |

### Threshold changes from the trial

- **D1:** the first rule ("merged after the answer") gave 7 findings that were only Brian's tap
  before his merge. Now a finding needs 15 min or more, or no merge; the early re-ask is D1b.
- **E1:** T65's reports about #20 and #22 were 81% the same words but are about different PRs. A
  sure duplicate now needs the same `#n` refs; the rest go to the LLM.

### Proposals the trial supports (a sample of the daily output)

1. **Do not reopen a done thread for a supervisor's new message** (`desk.ts`, Sheeana, S). 40 of
   47 reopens began with Odrade's message (12 muster gathers, 16 new tasks); 31 did no work and
   cost $16.19. Options: the message files as a follow-up on the closed thread, and only a new PR,
   branch or dirty folder reopens it; or Odrade uses `team_delegate` for new work and the muster
   goes to agents, not to thread sessions. [A1:T36, A1:T53, A1:T16]
2. **Odrade's queue: 1 item per thread and reason per hour, and "silent" only after 10 min idle**
   (`desk.ts`, Sheeana, S). 44 items in 41 continues; 17 were for done work; T53 came 9 times in
   16 min; $9.62. [A2:T53, A2:T36, A2:T70]
3. **A cancelled run is not a failure when a run of the same name passed** (`desk.ts`
   `failingChecks`, Sheeana, S). 2 of 6 repair wake-ups were false; each cost Lucilla a turn and a
   report. [B1:updex#457]
4. **1 report per result** (night shift prompt or Team's prompt section, Sheeana, S). 16 of 29
   night shift reports came with a `team_message` within 30 min. Tell a delegated night shift that
   its report goes to Odrade by itself. [E3]
5. **Turn on "Automatically delete head branches"** (repository settings, Brian, S: 1 click in each
   of 11 repositories). 36 merged bot PRs still have their branch. [H1]

Also found, below the top 5: 4 shifts ended `blocked` on a Brian action (F1: a repository secret,
a canary decision, a host check, a write grant); 3 shifts burned 2 or more rounds in under 60 s
(F2); 6 Odrade reports are not in her index (I1); asks filed on closed threads 4 times (A4); 9 bot
PRs on no thread (H2: mostly this repository's own PRs).

Maybe fixed (rule 4): T11's 15 queue items "PR frostyard/snosi#924 needs a repair: no session",
01:07Z to 01:17Z, around the install of PR #26 (01:12Z), with none after.

## Appendix B: run the trial

```sh
npm run link                                  # the node_modules link to the Pocket checkout
node docs/plans/daily-audit/trial.mjs --hours 72 --out /tmp/audit.json
```

`PI_POCKET_DIR` and `ODRADE_DIR` point it at other folders. It needs `gh` signed in (any account
that can read the repositories). It prints the JSON and writes it to `--out`; it writes nothing
else.
