# Beacon: collect, analyze, act

Status: the direction for every change in this repository. Brian, 2026-11-04: "collect and measure as much as
possible so we can evaluate performance of prompts, models, etc. That should include collection, then analysis, then
action."

We want to know which prompts, briefs, models and thinking levels give good work, at what cost. The answer comes from
records, not from impressions. The work has 3 stages, in this order. A stage depends on the stage before it.

## First principle: deliberate and measured

Brian (T822): "it needs to be deliberate and measured, not seat of the pants." This rule comes before the 3 stages.

- No change to a model, a prompt, a brief template, a router weight or a policy on an anecdote or on 1 bad night.
- Each change starts as a written hypothesis, in the PR or the proposal, before the change (pre-registered): what
  changes, why, the metric, the baseline (the current numbers and their window), the success threshold, the minimum
  sample and the review date.
- 1 change at a time per metric, so the effect can be attributed. Name the confounders (repository, task kind, time
  of night).
- At the review date: keep, undo or extend, by the threshold written before. Record the decision and the numbers.
  "Inconclusive" is a valid result: then extend or undo, never keep by default.

## 1. Collect

**Principle.** Record as much as possible at the moment it happens: cheaply, durably, and in a store that exists.

Rules:

- No secrets and no credential contents. A text that can hold one is filtered or not kept.
- Append-only, versioned kinds. "Stored data is forever" (`AGENTS.md`): add a field or a kind; never rename one or
  change what it means.
- Collection never changes agent behavior. A record that fails leaves the work as it was (as `model-router.ts` does).
- No new store when an existing one fits: a Desk thread field, a durable document, or the audit's `findings.json`.
- Collect the baseline before a change: a hypothesis needs current numbers, and a confounder needs its field.

What exists today:

| Fact                                                                                            | Where it is recorded                                                                              |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Desk thread life: start, close, `why`, `outcome`, PRs, issues, plan task                        | `x.desk.threads` (`Thread` in `desk.ts`)                                                          |
| Thread events                                                                                   | `thread.events`, the newest 50 only                                                               |
| Agent reports                                                                                   | `x.desk.reports`, on the thread session                                                           |
| Asks to Brian, his answers, rewrites, his `why` and his marks                                   | `thread.asks` (`Ask` in `desk.ts`)                                                                |
| PR lifecycle: created, merged, closed, reopened                                                 | `PrFact` in `x.desk.dashboard` (`_desk-dashboard.ts`)                                             |
| Tokens and cost, by session, UTC day and `provider/model`                                       | `x.desk.usage` (`_desk-usage.ts`), Desk-linked sessions and their subagents                       |
| Router suggestion: kind, tier, model, thinking, named worker; features and brief hash           | `thread.route` (`ThreadRoute`), from `model-router.ts`, shadow only, on every delegation          |
| Shift rounds, verdicts, check results, worker, stop reason                                      | `x.night-shift.goal` (`Goal`, `RoundRecord`)                                                      |
| A stop after 3 same check failures, and its failing jobs (`goal.stopChecks`)                    | `goal.why` (#108), `SAME_FAILURES`; audit: `metrics.Q1.stops.goals[].checks`, `flakyKeys`         |
| Subagent spawns and sends: model, name, tools, brief                                            | Pocket's entries; `audit/sources.mjs` keeps 300 characters of a brief                             |
| Finished work: 1 entry per thread closed done (`completed`, `verified`), when `journal` is set  | PocketJournal: the `x.desk.journal` task writes it to frostnotes (`docs/plans/pocket-journal.md`) |
| Each day's findings and metrics                                                                 | `findings.json` of the daily audit, 1 folder per day                                              |
| `plan` tool calls and refusals of each planning session (pi-pocket-team#119)                    | Pocket's entries; `loadPlanSessions` in `audit/sources.mjs` keeps 600 characters of a refusal     |
| Tool calls of a planning session that name `desk.ts` or `pi-pocket/src` (source reads)          | Pocket's entries; `loadPlanSessions` keeps the tool name only, no argument text                   |
| PR refs and reviewed head of each `subagent` spawn and send                                     | Pocket's entries; `loadReviewCalls` keeps the refs, the PR numbers and the head SHA, no text      |
| Reviewer answers: the verdict (`Ready`, `Not ready`) and the labels of the blocking items       | Pocket's entries; `loadReviewAnswers` in `audit/sources.mjs` keeps no answer text                 |
| Guard of each blocking point: test, `AGENTS.md` rule, correction record after the reviewed head | `metrics.Q1.blockers.points[].guard` in `findings.json`; a final result is not fetched again      |
| GitHub webhook deliveries: each accepted fact and refusal, counts by outcome, the last delivery | `x.github-hooks.deliveries` (`github-hooks.ts`), the newest 2000; no free text                    |
| Webhook alarms: system (`bind-failed`, `secret-missing`, …) and coverage, raised and cleared    | `x.github-hooks.alarms` (`github-hooks.ts`); the audit does not read it yet                       |

Gaps:

- **No prompt or brief version.** No delegation, brief template or system prompt carries a hash or a template id. Two
  versions of a prompt cannot be compared.
- **Model and thinking level actually used.** The router records what it would pick, and the goal records the named
  `worker`. No module of this repository records the thinking level asked for or used per session.
- **Router coverage.** Closed: a route, with the brief's features (version 1) and its SHA-256 (`briefHash`), is
  recorded on every `team_delegate` delegation, not only a shift (a plan start and a Clerk start
  have none). R1 still counts shifts
  only.
- **Wall time and rounds are partial.** A goal keeps only its newest 30 rounds (`KEPT_ROUNDS`), and a new goal in the
  same session writes over the old one. A thread keeps only its newest 50 events.
- **Cross-review verdict.** Partly closed: the audit parses each reviewer answer for its verdict and its blocking
  items (`loadReviewAnswers`). The parse reads free text: an answer in a format it does not know gives no item (Q1
  counts a `Not ready` answer with no item as `unparsed`), and no module records the verdict as a field.
- **Tool errors.** The audit reads errors of the team tools and the `plan` tool only (`loadToolErrors`), not of every
  tool.
- **Outcome after merge.** Reverts are found by PR title and body (Q1). Nothing links a later fix PR to the PR it
  fixes.

## 2. Analyze

**Principle.** The daily audit (`audit/daily.mjs`) is the 1 place that turns records into numbers. A dashboard shows
numbers; it does not judge them. The audit is read-only and stays inside its budget: at most 40 GitHub calls a run,
and 1 model call of at most $0.50 a day (`audit/llm.mjs`).

What exists today:

- **Checks A1 to J1, P1, R1 and Q1** (`audit/checks.mjs`), each a finding with a severity, cases and evidence. A check
  whose source fails is skipped and named; the run goes on.
- **Day compare.** `findings.json` of earlier days gives "new", "repeating 3+ days" and "gone" (`compareDays`).
- **Maybe fixed.** A finding whose last case is older than the install of its module (`desk.ts` or `night-shift.ts`)
  is "maybe fixed", not ranked (`isMaybeFixed` in `audit/report.mjs`).
- **R1** compares the router's shadow suggestion with what ran, and how each thread ended. A rate shows only at 10
  threads or more.
- **Q1** (T801): decided acceptance, `(merged − reverted) / decided`, per repository and per agent, over 30 days. A
  finding needs 8 or more decided PRs and 25 or more covered days. T801 t12 added review rounds per PR (reviewed heads,
  median and P90), 3-failure stops (2 in 7 days per repository), and CI reruns from the flaky-test scan.
- **Q1 `prRounds` and `blockers`** (measurement only, no finding): cross-review rounds per PR from the session
  records (`rounds`: the reviewed heads, `heads`, `calls`, mean, median, P90, PRs with 3 or more rounds, round calls
  with no PR), and every blocking
  point of a reviewer answer with its PR, its reviewed head, the PR's state and its guard: a test or an `AGENTS.md`
  file of the PR's own diff that is new or changed at the final head against the reviewed head, and the lines added to
  `.memory/corrections.jsonl` between them plus the new record files under `.memory/corrections/` (a record moved out
  of the old file after the reviewed head is not new). `rate` is guarded points over evaluated points, null at 0.
  GitHub calls, inside the cap of 40 and with no compare: at most 8 PR queries of 40 PRs, then at most 4 blob queries
  of at most 150 object lookups a run, newest first; the rest stay pending for the next run.
  A PR with an error on its alias, or with no whole file list, stays pending, never final. `blockers.guards` names
  each kind of failed or partial GitHub answer (no GitHub text), and `pending` counts every `ref@head` with no final
  result yet. All earlier review calls are read, with no lower time limit: a spawn of any age still sets the round
  and the PR of a send or an answer in the window.
- **F3** compares a subagent's model with the brief's worker. **J1** gives spend per day, agent and thread.
- **P1** (pi-pocket-team#119): plan tool friction, per planning session and in sum: `plan` calls, refused calls, the
  rate (null at 0 calls), refusals with 1 of 6 targeted texts (`targetedBy` counts each text), and source reads. Only a
  session with a source read is a finding (low); the rate is a metric for the hypothesis review. **A4** counts repeated
  `plan` errors too.
- **The Desk dashboard** (`_desk-metrics.ts`): completion, velocity, cycle time, PR counts and usage sums, per
  repository and owner, with unknown kept as unknown, not 0.

Gaps:

- **No comparison by model, by prompt version or by task kind** outside R1. `x.desk.usage` keeps the model, but no
  metric groups outcomes by it.
- **No cost per merged PR.** Usage and PR outcomes are both collected; nothing joins them.
- **Sample minimums are first guesses.** Q1's thresholds wait to be tuned after 2 weeks of records. A new comparison
  must state its minimum before it makes a claim.

Rules for a new analysis: state the minimum sample; keep "not enough data" apart from "good"; keep unknown apart from
0; split by the named confounders; compare with the baseline and the threshold written before; read only; stay
inside the call budget.

## 3. Act

**Principle.** A number that changes nothing is noise. Every finding leads to a proposal, a decision, and a second
measurement.

What exists today:

- The audit writes at most 5 proposals. Each cites finding ids. Code, not the model, gives the owner and the size
  (`ownerOf` in `audit/report.mjs`).
- Odrade reads the report for the 07:30 brief (README.md, "Daily audit").
- A blocking review point gets a guard: a test or an `AGENTS.md` rule, and 1 record file in `.memory/corrections/`,
  or 1 line in `.memory/corrections.jsonl` in a repository that still has it.

The loop:

1. A finding becomes a proposed experiment in the form of the first principle, with an owner, a size and its
   evidence (finding ids, numbers, dates).
2. Brian approves every experiment that changes a model, a prompt, a brief template, a router weight or a policy. An
   agent proposes; it does not switch.
3. After the change, the audit measures the same metric against the baseline, with the same minimum sample.
4. At the review date: keep, undo or extend, by the threshold. The decision and the numbers are written down.

Gaps:

- **The audit does not propose experiments in this form.** Its proposals have no baseline, threshold or review date.
- **No before and after for a model or prompt change.** "Maybe fixed" works only for a module install.
- **No record of a hypothesis, its decision and its result.** Nothing ties them to the later numbers.
- **The router has no live mode.** Its modes are `off` and `shadow`. The path to live: R1 shows, with enough threads
  per cell, that the suggestion does as well or better at the same or lower cost; the owner proposes it as an
  experiment (first principle), for 1 task kind first; Brian decides; at the review date the audit compares live
  routes with the shadow baseline, and Brian keeps it, extends it, or turns it back to shadow.

## How to use this beacon

A PR author:

- [ ] Say in the PR what the change records, and where the audit reads it (a check id, a metric key, or "none").
- [ ] A new module, route, prompt or model choice records its version (a hash or an id) and its outcome.
- [ ] A new field or kind is append-only and documented as stored data. No secret goes in.
- [ ] Collection cannot change what an agent does, and its failure leaves the work as it was.
- [ ] A new analysis states its minimum sample and its budget.
- [ ] A change to a model, a prompt, a brief template, a router weight or a policy has its written hypothesis in the
      PR: metric, baseline and window, threshold, minimum sample, confounders, review date. It is the only change to
      that metric.

A reviewer:

- [ ] The PR says what it records, or says why it records nothing.
- [ ] No new store where an existing one fits; no renamed or changed field.
- [ ] No claim from fewer samples than the stated minimum, and no change from an anecdote or 1 bad night.
- [ ] A hypothesis was written before the change, and the threshold did not move after the numbers came in.
- [ ] A gap stays marked as a gap: the PR does not describe a feature that does not exist.
