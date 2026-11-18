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

**Hypothesis.** A fresh `team_delegate` linked session for every new task reduces repeated context reads on ordinary
implementation work without increasing Q1 review rounds per PR. Same-task questions and continuations stay on their
original thread; a new task never rotates or cancels work in flight, an open ask, a lease or restart state. See the
[Team policy](modules/team.md#repository-ownership).

**Baseline and window.** Freeze the 2026-11-18 measurement snapshot before this policy takes effect:

- Q1's 30-day window, `2026-10-20` through `2026-11-18`, covers 1385 PRs: median 2 review rounds, P90 3. Its
  `2026-11-11T11:30Z` through `2026-11-18T11:30Z` recent subset has 490 PRs: median 1, P90 3. Preserve those exact
  cohorts when comparing affected agents and work repositories; do not select a different recent subset after
  seeing the result.
- Murbella session `918743`: 1032 calls, median request context 195,210.5 tokens, recorded cost $143.68.
- Teg session `1142164`: 1038 calls, median request context 139,525.5 tokens, recorded cost $219.51, including
  $140.38 cache-read cost. Cache-read cost per call is $140.38 / 1038 (about $0.13524); Murbella's cache-read
  component was not supplied and must not be treated as 0.
- Request context means `input + cacheRead + cacheWrite`. These session aggregates are diagnostic baselines, not
  evidence that their task mix is comparable. Freeze the underlying pre-policy session records with the review.

The post-policy window starts at the actual installation time of this change and ends at the review on
**2026-11-25**. Record that installation timestamp and the installed commit as the policy version before collecting
post-policy results. Freeze a separate old-policy control from `2026-11-18T19:30:59.613Z` (the settings-change
boundary) to installation, before the policy loads. The control and treatment therefore run under the same saved
`compaction.modelOverrides` settings. If that control has no comparable tasks, the review can only extend.

Count only new linked tasks started under this policy; leave existing tasks on their original threads. For this
experiment, an ordinary implementation task is a desk thread whose recorded model-router `route.kind` is exactly
`implement`; exclude plan, review, debug, research, write, operate and other kinds. Match control and treatment by
agent, repository and session model. Keep only matched cells with at least 5 completed control tasks and 5 completed
post-policy tasks; a cell with no match is reported and excluded. Report every cell and its sample, and pool all
included cells for the decision. Do not hand-select task kinds after the result is known.

**Metrics and quality guard.** Read median request context and cache-read cost per call from the session records
for those comparable tasks, including their worker subagents consistently before and after. Report cache-read cost
per call as total cache-read cost divided by calls; do not substitute total session cost. Review Q1 review rounds
per PR for the affected agents and work repositories against both frozen cohorts above: the all-PR baseline is
median 2 / P90 3, and the recent subset baseline is median 1 / P90 3. Compare P90 on the matching cohort.
The existing audit reads review rounds in `metrics.Q1.prRounds`; session records supply the cost signals. This
prompt-only change adds no collection, stored kind or field; linked-session outcomes and desk reports already exist.
Attribute a post-policy PR through its `thread.prs` link only after its newest cross-review has finished; open PRs
with no finished review stay pending and are excluded from the 2026-11-25 quality numerator. Report pending PRs.

**Confounders.** Split or disclose agent, repository, task kind and size, model/provider, worker and reviewer model,
thinking level, time of day, cache pricing/hits, task completion bias and concurrent policy changes. At
`2026-11-18T19:30:59.613Z`, `settings.json` changed `compaction.modelOverrides.<model>.reserveTokens` to `650000` for
`github-copilot/mai-code-2`, `github-copilot/mai-code-2-flash`, `github-copilot/gpt-6-luna`,
`github-copilot/claude-sonnet-5.5`, `github-copilot/claude-opus-5.5` and `anthropic/claude-opus-5-5`. The old-policy
control begins after that boundary and ends before this policy installs, so the keep comparison cannot be credited
to that settings change. A result that lacks this control extends, never keeps.

The `openai/gpt-6.1-sol` worker trial ends on 2026-11-23 and uses Q1 cross-review rounds. Split its PRs from the
other worker models in the quality report and compare each with the same worker-model stratum in the frozen
baseline; never pool those results into a single unmatched Q1 claim. The Murbella diagnostic used
`anthropic/claude-opus-5-5`; the Teg diagnostic used `openai/gpt-6-astra`, so neither diagnostic is the MAI model
that prompted this policy or evidence of the setting's effect. This extension cannot set per-role compaction
through Pocket's public extension API. This experiment changes neither configuration nor core compaction.

**Minimum sample and decision.** Review on **2026-11-25** with at least **20 completed post-policy implementation
tasks** and **8 finished reviewed PRs**, all in matched agent/repository/model cells that meet the 5-and-5 cell
minimum. The control must begin after the settings boundary and have the same saved settings. Recompute the frozen Q1
baseline for exactly the affected agents, repositories and worker-model strata; do not compare them with all-team
populations. Apply the same no-rise rule to both the 30-day and recent-subset baselines: a median rise greater than
0 rounds or a nearest-rank P90 rise of 1 or more fails the quality guard. The recent subset is still reported as the
primary quality sensitivity check because it controls for older work less well matched to the post-policy tasks.

Keep only if the pooled treatment median request context across the included matched `implement` tasks is at least
**20% lower** than the weighted control median, and every reported matched cell has the same 20% direction with no
failure in the quality guard. For this calculation, each treatment and control call keeps its recorded context.
The control call weight in a cell is `treatment calls in that cell / control calls in that cell`; the weighted median
is the context where the normalized cumulative call weight crosses 0.5, with linearly averaged middle contexts when
needed. This gives each control cell the treatment cell's share of calls. Report cache-read cost per call beside the
primary context result. With only 8 PRs, the median moves in 0.5-round steps;
treat any positive median rise as the stated failure, not noise. If the sample, comparable cells, post-settings
control, worker-model split or finished-review attribution is missing, extend and record a new review date; do not
keep by default. If a sufficient sample and the threshold or quality guard fails, undo this policy. Record the
numbers and the keep/undo/extend decision here.

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
