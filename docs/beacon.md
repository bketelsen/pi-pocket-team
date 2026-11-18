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

## Experiment: fresh linked task sessions (pre-registered 2026-11-18)

**Hypothesis.** A fresh `team_delegate` linked session for every new task reduces repeated context reads on long,
multi-task sessions without increasing Q1 review rounds per PR. Same-task questions and continuations stay on their
original thread; a new task never rotates or cancels work in flight, an open ask, a lease or restart state. The
prompt rule is easy to undo, so the decision uses quality, not a causal cost threshold. See the
[Team policy](modules/team.md#repository-ownership).

**Baseline and window.** Freeze the 2026-11-18 Q1 snapshot before this policy takes effect:

- Its 30-day window, `2026-10-20` through `2026-11-18`, covers 1385 PRs: median 2 review rounds, P90 3.
- Its `2026-11-11T11:30Z` through `2026-11-18T11:30Z` recent subset covers 490 PRs: median 1, P90 3.
- Recompute each baseline for exactly the post-policy agents and repositories, split by worker model, before the
  quality comparison. Keep the frozen all-team rows only as descriptive context.
- Murbella session `918743` shows the long-session case: 1032 calls, median request context 195,210.5 tokens, recorded
  cost $143.68. Teg session `1142164` shows 1038 calls, median request context 139,525.5 tokens, recorded cost
  $219.51, including $140.38 of cache-read cost. These sessions are diagnostic examples, not a matched cost control.
- Request context means `input + cacheRead + cacheWrite` from each assistant call.

The post-policy window starts at the actual installation time and ends on **2026-11-25**. Record the installation
timestamp and installed commit as the policy version. Leave every existing task on its original thread. Count a task
as completed only when `thread.state == "closed"`, `thread.closed.why == "done"`, and `thread.closed.outcome` is
`completed` or `verified`.

**Descriptive context measure.** It is evidence, not a keep criterion, because pi-pocket-team #266 (CI wait), #261
(brief reads), and the `reserveTokens` setting change also affect request context in this period. For the population
of every agent main session, exclude subagent conversations and supervisor/Clerk sessions. Split by provider/model.
For the same duration before and after installation, report by model:

- calls, sessions, median request context per call, P90 and maximum;
- the share of calls above 150,000 request-context tokens;
- cache-read cost per call and total recorded cost.

Use each call's timestamp, never a session's final state. If a pre-install or post-install model has no calls, report
it as missing, not 0. Include long sessions regardless of whether their thread closes. Name #266, #261, and the
settings change beside the result. Do not interpret a cost movement as the policy's causal effect.

At `2026-11-18T19:30:59.613Z`, `settings.json` changed
`compaction.modelOverrides.<model>.reserveTokens` to `650000` for `github-copilot/mai-code-2`,
`github-copilot/mai-code-2-flash`, `github-copilot/gpt-6-luna`, `github-copilot/claude-sonnet-5.5`,
`github-copilot/claude-opus-5.5` and `anthropic/claude-opus-5-5`. The Murbella diagnostic is on the reserve list;
the Teg diagnostic uses `openai/gpt-6-astra`. This extension cannot set per-role compaction through Pocket's public
extension API, and this experiment changes neither configuration nor core compaction.

**Quality guard.** Q1 review rounds are the decision metric. Attribute a post-policy PR through its `thread.prs` link.
A review is finished only when the newest matching review call has a parsed `reviewAnswers.ready` value (true or
false). Exclude and report a PR with no parsed answer or a missing link. Report pending PRs. The existing audit reads
finished review calls in `metrics.Q1.prRounds`; this prompt-only change adds no collection, stored kind or field.

For the affected agents and repositories, compare post-policy PRs with the frozen 30-day and recent Q1 rows after
both are split by worker model. A median rise greater than 0 rounds or a nearest-rank P90 rise of 1 or more fails the
guard. Also report the worker model, repository, agent, PR count and recent subset. The `openai/gpt-6.1-sol` worker
trial ends on 2026-11-23; keep its rows separate from every other worker model instead of pooling them.

**Minimum sample and decision.** Review on **2026-11-25**. The guard needs at least **8 finished reviewed PRs** across
post-policy tasks and matching baseline cohorts. Worker-model strata with fewer than 3 finished PRs in treatment or
baseline are reported as low sample, not used to fail independently; the aggregate still needs 8 treatment PRs and
the same matched baseline population. If the 8-PR minimum is not met, extend and record a new review date.

Keep the prompt rule when the sample is sufficient unless any sufficiently sized Q1 stratum fails, or the matched
affected-agent/repository aggregate fails. Undo the rule if the quality guard fails. Context, cache-read cost and the
share above 150,000 tokens are descriptive and cannot alone keep or undo the rule. Record the numbers, confounders and
the keep/undo/extend decision here.

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
  with no PR). Each PR also records `worker` (`none`, 1 model or `mixed`) and sorted distinct `models`.
  `prRounds.workers` records PR counts, rounds, mean, median and P90 by worker label, with `weeks` for Monday weeks
  from the New York date of each PR's last round call ([module reference](modules/daily-audit.md)). The oldest week
  can be partial at the 30-day edge. The report shows weekly means and PR counts. The worker-model trial review
  compares a worker's mean rounds per worker-written PR against the baseline week. The same metrics also record every
  blocking point of a reviewer answer with its PR, its reviewed head, the PR's state and its guard: a test or an `AGENTS.md`
  file of the PR's own diff that is new or changed at the final head against the reviewed head, and the lines added to
  the old single corrections file (`CORRECTIONS_FILE` in `audit/sources.mjs`) between them plus the new record files under `.memory/corrections/` (a record moved out
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

- **Comparison by model is partial.** R1 groups thread outcomes by model. Q1 groups review rounds per PR by worker
  model. No metric compares prompt versions or groups PR acceptance by worker model.
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
- A blocking review point gets a guard: a test or an `AGENTS.md` rule, and 1 record file in `.memory/corrections/`
  (name `<date>-pr-<N>-<words>.json`, core ADR-0081).

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

## Message clock trial

[PR #268](https://github.com/bketelsen/pi-pocket-team/pull/268) adds a clock to incoming agent-session messages, not tool results. [Team](modules/team.md#message-clock), [Desk](modules/desk.md#the-module-complete) and [Shift](modules/shift.md#delegated-shifts) use the shared helper; Desk digests keep their existing `Now …` header.

- **Hypothesis:** a local clock in delegation briefs and ordinary linked-session messages reduces turns used only to run `date`, without the repeated context cost of stamping every tool result.
- **Metric and baseline:** date-only turns per week. The 2026-11-11..18 session-entry review counted 395 date-only turns and about 50M context tokens. That token total is baseline context volume, not a promised saving.
- **Collection and audit:** Pocket already stores incoming messages, tool calls and model usage in session entries. The stamp is recorded in those incoming messages; no new store or document kind is added. The weekly review reads those entries and counts turns whose only tool work runs `date`, using the same classification as the baseline. There is no automated daily-audit check for this metric yet.
- **Proposed success threshold:** at most 316 date-only turns in a full 7-day post-install window, a reduction of at least 20% from 395. Minimum sample: 1 complete week after install. Review date: 2026-11-25; extend if a complete post-install week is not available. Keep only if the threshold holds; otherwise undo or extend explicitly, never keep an inconclusive result by default.
- **Confounders:** message and task volume, repository, task kind, time of night, other prompt changes and concurrent changes to long-wait tools. Compare those before attributing a reduction to this change.

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
