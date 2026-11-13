# Plan: router bench

The router bench measures the candidate worker models on replays of merged tasks (cost, tokens, wall time and
quality), and turns the result into the tiers of the next model router (router v3, [model-router.md](../modules/model-router.md)).
The bench's pre-registration fixes every rule, number and seed before any paid run; this plan puts the work in order
and records what each step settled. The scripts and their data are in [bench/README.md](../../bench/README.md). After
router v3, the daily audit's R2 check measures the routed threads end to end ([daily-audit.md](../modules/daily-audit.md)).

Status: phase 1 done (pi-pocket-team#164); phase 2 done: the judges passed the held-out test (2026-11-08); phase 3
done: stage 1 ran and the rule is frozen (2026-11-09). Phase 4: the branch is `wait` (2026-11-10, R = 22, under 30);
stage 2 waits for the monthly rounds (next: 2026-12-01), and no band has a pick yet.

## Phase 1 — Pool gate (this change)

- `bench/pool.mjs` (logic in `bench/lib/pool.mjs`, tests in `bench/pool.test.mjs`) writes `bench/pool-v1.json`: 3
  disjoint sets of the owners' kept tasks (calibration, stage 1, stage 2 = R), frozen once written.
- `bench/analyze.mjs`: the stage 2 branch (confirm, merge, constant only, wait), the `--branch` command, and the pool
  checks of `--stage 1` and `--stage 2`; stage 1 reports the 2 groups that stage 2 can merge.
- **Done when:** `bench/pool-v1.json` is on `main`, `node bench/pool.mjs --check` exits 0 there, and no paid run has
  started before it.

### Pool v1

Written on 2026-11-08 from the owners' reviewed manifests (70 kept tasks: the round 1 review, and the fleet, nsl
and lodge re-harvest review):

| Set         | Tasks | small | medium | large | sheeana | irulan | lucilla | duncan | teg |
| ----------- | ----- | ----- | ------ | ----- | ------- | ------ | ------- | ------ | --- |
| calibration | 12    | 4     | 4      | 4     | 0       | 3      | 3       | 3      | 3   |
| stage 1     | 36    | 8     | 16     | 12    | 9       | 3      | 8       | 8      | 8   |
| stage 2 (R) | 22    | 0     | 2      | 20    | 13      | 0      | 5       | 4      | 0   |
| kept        | 70    | 12    | 22     | 36    | 22      | 6      | 16      | 15     | 11  |

- Calibration: every owner has 3 tasks, 1 per stratum (`short` is 0 for each). Sheeana's items come from the pilot.
- Stage 1: 36 tasks. Small had 8 left after calibration, so medium filled 4. The swap pass moved 2 large tasks from
  sheeana to teg. Outside 6 to 8: irulan (3, all its tasks left after calibration) and sheeana (9: 3 + 4 x 8 = 35,
  so 1 owner must hold 9).
- **R = 22, under 30: stage 2 waits** (branch 4), whatever tiers the frozen rule predicts. It runs when monthly
  harvests (`--grow`) bring R to 30 or more; at the latest on 2027-01-31, stage 1 is reported as exploratory and no
  live change follows. R has no irulan or teg task: a failed held-out round of the judge calibration, which takes 2
  more tasks per owner from R, has none for those 2 owners until a harvest adds some.

Cost estimate, list price, from the pilot's mean of $0.95 an attempt (range $0.95 to $2.00, as the pilot ran 1
repository) and about $0.08 a judge call ($0.17 an attempt for 2 judges). Spent so far: $34.75 of the $3,000
budget.

| Step                                                      | Attempts  | Attempts cost  | Judges     |
| --------------------------------------------------------- | --------- | -------------- | ---------- |
| Calibration: 4 owners x 3 tasks x 4 models                | 48        | $46 to $96     | about $20  |
| Calibration top-up, if short of a class                   | up to 20  | $19 to $40     | in the $20 |
| Reserve: 1 failed held-out round (2 tasks x 4 owners x 4) | up to 32  | $30 to $64     | about $10  |
| Stage 1: 36 tasks x 10 models                             | 360       | $342 to $720   | about $61  |
| Stage 2 now (wait)                                        | 0         | $0             | $0         |
| Stage 2 ceiling, once R allows: 3 groups x 60 x 4 models  | up to 720 | $684 to $1,440 | about $122 |

Calibration and stage 1 together: about $500 to $970 with the spend so far, $540 to $1,050 with the reserve. With
the stage 2 ceiling, at most about $2,610: inside $3,000. The budget guard (`bench/budget.mjs`) stops the bench at
$3,000 in any case.

The inputs are the owners' reviewed manifests, `~/agents/<owner>/bench/<repository name>.json` for each bench
repository (`BENCH_REPOS` in `bench/lib/owners.mjs`). Only kept tasks count (`owner.keep` with both confirmations). A
missing manifest, a task of a repository that is no bench repository, a repeated task id, and a task whose PR is a
pilot PR (`bench/pilot.json`) are each an error: pilot tasks never join the pool. The size stratum of a task is its
lines changed: small up to 50, medium 51 to 300, large over 300.

The pre-registered rule: seed 1064 over the kept tasks sorted by id; (a) calibration: 3 kept tasks of each owner
except Sheeana (her items come from the pilot tasks, which are not in the pool), 1 dev and 2 held-out, 1 per size
stratum where the owner has one; (b) stage 1: 36 tasks, 12 per stratum, 6 to 8 per owner where possible; a stratum
with fewer than 12 gives all and its neighbour fills it (small from medium, large from medium, medium from large);
fewer than 30 in all: no stage 1, the bench waits for the pool; (c) stage 2: every other kept task, R.

Where that text leaves a choice open, the script makes these choices:

- **Rank.** The kept tasks are sorted by id (a plain code-unit compare), then shuffled 1 time by Fisher-Yates driven
  by mulberry32(1064). The position in that list is the task's rank. Every later choice takes the best rank first,
  and no other random number is drawn: the pool depends only on the set of kept tasks.
- **Calibration.** For each owner in the fixed order (irulan, lucilla, duncan, teg), the owner's best-ranked task of
  each stratum, in the order small, medium, large. An owner with no task of a stratum fills up to 3 with its next
  best-ranked tasks. The 3 picks in rank order: the first 2 are held-out, the 3rd is dev. An owner with fewer than 3
  kept tasks gives all of them, held-out first (2 tasks: 2 held-out and no dev; 1 task: 1 held-out); the file records
  the missing count as `short`.
- **Stage 1 quotas.** A is the count of each stratum left after calibration. Fewer than 30 in all: stage 1 is
  `wait` with no task, and R is every task left. 30 to 36: stage 1 takes every task left, and R is empty. Else each
  stratum's quota is the smaller of 12 and A; then the deficits are filled from the neighbour's spare (A minus the
  neighbour's quota, updated as it is taken), in this order: small from medium, large from medium, medium from large.
  The total is 36 when the pool allows. The file records each fill (`fills`).
- **Stage 1 owner balance.** 2 passes. The greedy: until every quota is 0, among the tasks left whose stratum has
  quota left, take the task of the owner with the fewest stage 1 tasks so far, a tie to the best rank. The greedy
  alone can leave an owner far above another (the quotas of a stratum run out before a late owner's turn), so a
  deterministic swap pass follows. Repeat: for each owner `a` in descending stage 1 count (a tie in the fixed owner
  order: sheeana, irulan, lucilla, duncan, teg), find the owner `b` with the fewest stage 1 tasks (the same tie) such
  that `a` has 2 or more tasks more than `b`, and a stratum (in the order small, medium, large) where `a` has a
  selected task and `b` has an unselected task left after calibration. The first such pair swaps: `a`'s worst-ranked
  selected task of that stratum goes out, `b`'s best-ranked unselected task of it comes in. The stratum counts stay
  the same, and each swap lowers the sum of squares of the owner counts, so the loop ends; it stops when no pair
  exists. The file records each swap (`swaps: [{ out, in, stratum }]`). Owners still outside 6 to 8 are listed in
  `outsideRange` ("where possible": a record, not an error).
- **Stage 2 (R).** Every kept task in no other set, in rank order. The order matters: stage 2 takes the first n tasks
  of a group in this order.
- **Frozen.** The file has no time stamp and no absolute home path, so the same inputs give the same bytes. A run
  whose new content differs from the file exits 1 and writes nothing. `--grow` keeps calibration and stage 1, appends
  each new kept task to the end of R (in rank order, as 1 entry of `stage2.rounds`), and refuses a pool task that is
  no longer kept. `--check` recomputes and writes nothing.

## Phase 2 — Judge calibration

- The judges calibrate on real bench attempts: 4 models per calibration task of the pool (`calibration.owners`: 1
  dev and 2 held-out tasks per owner), 48 attempts in all; Sheeana's 12 items come from the pilot attempts on her 3
  pilot tasks. The split into dev and held-out is by task, so no task is in both.
- The owner of each repository labels its items blind (pass or fail by
  [bench/calibration-labels.md](../../bench/calibration-labels.md)), with the judge's input only. The judge prompt may
  change on the dev items only, then it is frozen by SHA-256 before the held-out test.
- The held-out test runs once: each judge must agree with the owners on 80% or more of the counted items with a
  kappa of 0.6 or more, and the 2-judge rule must have a false-pass rate of 20% or less.
- **Done when:** the held-out result (agreement, kappa and both error rates with their bounds) is recorded here, before
  the first stage 1 score counts.

### Result (2026-11-08)

The record is [bench/judge-calibration.md](../../bench/judge-calibration.md).

- **Dev:** 20 items (12 owner passes, 8 owner fails), 3 rounds. 2 prompt changes: `judge-v2.md` takes the owners'
  label rule (grade a defect by the size of its fix); `judge-v3.md` adds that a minor fix never adds what the author
  missed, and that all the fixes count together. Only version 3 passes for both judges and for S3 on the dev items.
- **Freeze:** `bench/judge-v3.md`, `JUDGE_PROMPT_SHA256` =
  `23c5c31c42ef09ca72dc4365d50779951c86c4339c6639caae2f4203d7872fb9`, committed before any held-out call.
- **Held-out:** run once; 39 counted items (26 owner passes, 13 owner fails), no top-up, no item left out. **PASS.**

| Rater                            | Agree (need 32) | Kappa | False pass, 80% bounds  | False fail, 80% bounds   | Pass |
| -------------------------------- | --------------- | ----- | ----------------------- | ------------------------ | ---- |
| `openai/gpt-6.1-sol`             | 34 of 39        | 0.737 | 0 of 13 (0.0% to 11.2%) | 5 of 26 (11.3% to 30.8%) | yes  |
| `github-copilot/claude-opus-5.5` | 37 of 39        | 0.889 | 0 of 13 (0.0% to 11.2%) | 2 of 26 (3.2% to 17.2%)  | yes  |
| S3 (both 3 or more)              | 34 of 39        | 0.737 | 0 of 13 (0.0% to 11.2%) | 5 of 26 (11.3% to 30.8%) | yes  |

- **Reading:** every miss is a false fail: on this sample S3 rejected 5 of 26 owner passes and accepted 0 of 13 owner
  fails. The rates are pooled; an error rate per candidate model is not established.
- **Rubric:** `judge-v3.md` keeps the words of grades 1 to 4; grade 0 reads "the build breaks and needs more than a
  minor fix", which follows the owners' label rule for a minor fix (the record gives the reason).
- **Spend:** $12.52 of judge calls (dev $6.42, held-out $6.10); the bench's ledger is at $83.45 of $3,000.

### The instrument

- `bench/calibration.mjs` (logic in `bench/lib/calibration.mjs` and `bench/lib/calibration-cli.mjs`): the plan of
  the attempts (4 models per task: 2 cheap, 1 middle, 1 dear, each group in a seeded order taken in turn), the runs in
  the runner stage `calibration` with their checks (`bench/score.mjs --checks-only`: S0 to S2, no judge call), the
  replacements of failed attempts, and the blind label packs with their keys. The rules are in
  [bench/README.md](../../bench/README.md), section "Calibration".
- `bench/judge-calibration.mjs` (logic in `bench/lib/judge-calibration.mjs`, statistics in `bench/lib/agreement.mjs`):
  the judges on the labelled packs, with agreement, Cohen's kappa, both error rates with 80% Wilson bounds, and the
  class minimums. The held-out set runs only with the frozen prompt (`JUDGE_PROMPT_SHA256`) and only when it is
  valid.
- The first instrument (pairs of a Not-ready head and its merged head, from the daily audit's blocking review points)
  is retired: it could not test the rubric, as a head with 1 or 2 small blocking points is "acceptable with minor
  fixes", and many of its held-out items were not blind. Its files stay in `calibration/` of the data dir.
- The packs go to the owners only after `bench/calibration-labels.md` is on `main`.

## Phase 3 — Stage 1 (explore)

- The 10 candidates run on the 36 stage 1 tasks (`bench/batch.mjs`), each attempt scored (`bench/score.mjs`).
- `node bench/analyze.mjs --stage 1` gives the bands, B1, the shortlists, C1, the 2 merge groups (easy+medium,
  medium+hard, each on the union of its 2 bands) and the rule; the rule is frozen as `bench/rule-v1.json`.
- **Done when:** `bench/results/stage1/summary.json` holds every stage 1 task, and `bench/rule-v1.json` is on `main`.

### Result (2026-11-09)

The record is [bench/results/stage1/summary.md](../../bench/results/stage1/summary.md) (and `summary.json`); the
frozen rule is [bench/rule-v1.json](../../bench/rule-v1.json). How it ran: [bench/README.md](../../bench/README.md),
"Stage 1".

- **Runs:** 360 of 360 recorded and scored (36 tasks x 10 models), from 2026-11-08 16:18Z to 2026-11-09 23:14Z. No
  harness failure, no provider failure, no task dropped. Failures that count against the model: `limit` 32
  (halogen 13, Gemini 10, Grok 3, MAI-Code 3, DeepSeek 2, Haiku 1) and `protocol` 12 (the attempt read
  `/agent/auth.json`: Grok 6, DeepSeek 4, halogen 2).
- **Bands:** easy 15, medium 14, hard 5, unsolved 2 (pi-pocket-team-72, fleet-109). The majority band is easy
  (15 of 36).
- **B1:** `github-copilot/claude-opus-5.5` in every band and in both merge groups; it passes 31 of 36 tasks (31 of the
  34 solved ones). **Shortlists:** easy: `github-copilot/gpt-6-luna`, `deepseek/deepseek-flash`; medium, hard,
  easy+medium and medium+hard: none (no model reaches P(gap <= margin) >= 0.5 against B1). **C1:** Opus itself (best
  overall). The $0 pricing of halogen and MAI-Code changes no pick.
- **Rule:** features `pathsNamed`, `briefChars`, `reposNamed`, `riskPathNamed`; nested leave-one-repository-out
  accuracy 0.288 over 9 folds, below the majority band's 0.417 on the same tasks. With these features, stage 1 shows
  no sign that the difficulty is predictable at delegation time; H1 is tested only in stage 2.
- **H2:** inconclusive by rule: only 10 of the 36 tasks (28%) have Jev numbers.
- **Self-preference** (mean grade of its own family's attempts against the other family's): `openai/gpt-6.1-sol` 3.00
  against 2.85 (72 own attempts); `github-copilot/claude-opus-5.5` 3.18 against 3.05 (107). Recorded only; it changes
  no score.
- **For stage 2's simulation:** against Opus over the 34 solved tasks, the discordant pairs are 9 of 34 (Sol) to 20
  of 34 (Gemini); about 13 of 34 for the cheap models.
- **Spend:** $398.02 in stage 1: attempts $274.95, judges $41.78, the attempts set aside $1.29, and $80.00 for 12
  runs that 2 restarts killed (settled at their full cap by `budget.mjs reap`). The ledger is at $481.47 of
  $3,000.

Incidents of the run, and what changed:

- **Pi Pocket version.** The Pi Pocket checkout moved to v0.28.0-bk.1 on 2026-11-07, after the pool's revalidation on
  v0.27.0. A pi-pocket-team check fails at its own merge on v0.28 (pi-pocket-team-84: 22 failing tests; on v0.27.0 it
  passes). The 10 attempts of pi-pocket-team-84 that ran on v0.28 (S1 false for every model) are set aside, and every
  pi-pocket-team task ran and scored on a v0.27.0 copy.
- **Disk full.** Each attempt kept its try caches (Go module caches: nsl-89 alone took 22 GB). On 2026-11-09 at about
  06:38Z they filled `/var` (123 GB in `runs/`), and the Pocket server crashed until the VM restarted. 1 attempt
  that met the full disk (nsl-76, MAI-Code) is set aside and ran again. The caches of every scored attempt are
  removed (about 105 GB), `bench/score.mjs --drop-caches` removes them after each score, and `bench/run.mjs`
  refuses to start below 12 GB free (exit 4, nothing spent).
- **Restarts.** The VM restart and a later server restart (2026-11-09 12:01Z) ended 12 attempts that were running or waiting for a slot; they ran again from the start.
  After the first one, the run used 1 queue of at most 4 attempts at a time.
- **A brief outside the sandbox.** nsl-76's brief asks the worker to read a plan file in an agent home, which the
  sandbox does not show. 7 or more models still passed it (easy); GPT-6 Luna stopped and asked for the file.

## Phase 4 — Stage 2 by the branch

- Before any stage 2 run, `node bench/analyze.mjs --branch` predicts the tier of each R task with the frozen rule and
  writes `bench/results/stage2/branch.json` and `branch.md`: the counts, the branch, each group's bands, n, deciding
  tasks and models.
- The pre-registered branch, in this order: (1) a predicted tier with 30 or more tasks is confirmed alone, on n = the
  smaller of 60 and its count; (2) a tier with fewer than 30 merges with its neighbour that has more tasks (easy with
  medium, hard with medium; medium with the larger of the 2); a merged group with 30 or more is confirmed as 1 group,
  with 1 pick for its bands; (3) no group reaches 30, and R is 30 or more: stage 2 confirms only the constant policy
  (C1 against B1 over all R tasks), and H1 and H3 are "not tested (pool)"; (4) R under 30: stage 2 waits. Each
  confirmed tier or group runs B1, its shortlist and C1 (at most 4 models); its deciding tasks are its first n stage 2
  tasks in the pool's order.
- The readings of the script: only the tiers that step 1 left merge, pairwise, and only with a tier that step 1 also
  left; medium's partner is the larger of easy and hard (a tie: easy); easy and hard never merge with each other; a
  tier with no partner stays alone. The branch is `confirm` when every confirmed group is 1 tier, `merge` when 1 has 2.
  A tier in no confirmed group gets no decision (`unconfirmed`). The constant branch takes the overall best model of
  stage 1 (B1) and C1. A stage 2 result of a task or model outside the branch's deciding sets is an error.
- **Done when:** `branch.json` is recorded before the first stage 2 run, and `node bench/analyze.mjs --stage 2` gives
  a decision for each tier, or the branch is `wait`.

### Branch record (2026-11-10)

`node bench/pool.mjs --check` exits 0 (pool v1 is unchanged: R = 22). Then `node bench/analyze.mjs --branch`, with 1
`--manifest` for each of the 9 input manifests of the pool, wrote
[bench/results/stage2/branch.json](../../bench/results/stage2/branch.json) and
[branch.md](../../bench/results/stage2/branch.md). Both are committed: each round's branch is part of the record.

- **Predicted tiers of R** (frozen `bench/rule-v1.json`): easy 11, medium 11, hard 0.
- **Branch: 4, `wait`.** R = 22 is under 30, so the tier counts do not matter yet. No stage 2 attempt ran, and none
  may run while the branch is `wait`.
- **Spend:** unchanged, $481.47 of $3,000 (`node bench/budget.mjs show`: settled $481.47, nothing reserved).

What the branch can give, with stage 1's model sets (a reading of the fixed rules, not a new rule): each confirmed
group runs B1, its shortlist and C1. Stage 1 has a shortlist only for easy (`github-copilot/gpt-6-luna`,
`deepseek/deepseek-flash`); medium, hard, easy+medium and medium+hard have none, and C1 is B1
(`github-copilot/claude-opus-5.5`). So only an easy tier of 30 or more predicted tasks, confirmed alone, compares a
cheaper model with Opus. A merged group, or the constant branch, runs Opus alone: when it decides, its only possible pick is Opus
(it can still be `inconclusive`, or keep today's policy when Opus fails a guard). At the mix of
R now (half easy, no hard), easy+medium reaches 30 when R reaches 30 (branch `merge`), and easy alone needs R of about 60.

### The decision now

The branch is `wait`, so stage 2 has decided nothing. Until a later round changes this table, it is the bench's
decision:

| Item                                  | Now                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| H1 (difficulty is predictable)        | Not tested: stage 2 waits. Stage 1 (exploratory): nested accuracy 0.288, below the majority band's 0.417.    |
| H2 (Jev adds little)                  | Inconclusive by rule (stage 1: Jev numbers on 10 of 36 tasks).                                               |
| H3 (tiers pay)                        | Not tested: stage 2 waits.                                                                                   |
| B per band                            | None confirmed. Stage 1 (exploratory): `github-copilot/claude-opus-5.5` in every band.                       |
| Pick per band (easy, medium, hard)    | None.                                                                                                        |
| Constant policy                       | None confirmed. Stage 1 (exploratory): C1 is `github-copilot/claude-opus-5.5`.                               |
| Picks at the stand-in price and at $0 | None at either price. In stage 1, the $0 price of halogen and MAI-Code changes no shortlist or C1.           |
| Router                                | Router v3 is built (t14) with `RULE_PICKS` empty: it assigns no worker, and Odrade still names every worker. |

### Live experiment

Not pre-registered yet. Its pre-registration needs a pick per band, and the control of each band is counted over the
eligible night-shift lines of the 30 days before stage 2 decides. It is written here when stage 2 decides, and before
the router's mode `assign` is on. If stage 2 decides nothing by 2027-01-31, no live experiment follows. These parts
are fixed already (plan T1064, section Rollout): the `easy` tier first, and not before 2026-11-18; the gate (R2
installed, with 14 days of baseline for the tier's eligible lines); 30 decided threads per arm; the review at the
start + 28 days or the sample, whichever comes first; keep when arm A's accepted rate is within the margin of arm B
(P >= 0.8) and its cost per accepted thread is lower; undo when arm A is below arm B by more than the margin with
P >= 0.8, at the interim look (15 decided per arm) or at the end; a revert of an arm A PR triggers a review at once;
else 1 extension of 28 days, then undo.

### Monthly rounds

While the branch is `wait`, the pool grows on the 1st of each month. The steps of a round:

1. **Harvest** (Sheeana), into a new folder per round: `node bench/harvest.mjs` with `--since` the day after the last
   window, `--until` the day before the round, `--out <data>/manifests-<yyyy-mm>` and `--fetch`. The check of a
   bketelsen/pi-pocket-team task passes only on the Pi Pocket release that its merge was tested on ("Phase 3",
   incidents): harvest those tasks with `--pocket` at that release, the CI pin at their merge (v0.28.0-bk.1 for merges from
   2026-11-07 until bketelsen/pi-pocket-team#200, v0.28.1-bk.1 for merges after it), and use the same `--pocket`
   for each task in stage 2.
2. **Owner review**, as in round 1 (scope, commands, keep or drop with a reason), on a copy of the round's new
   manifest, not on the owner's file: `--revalidate` checks every task of the file it gets with 1 `--pocket`, and
   the owner's file holds the pool's older pi-pocket-team tasks, which pass only on v0.27.0. So the owner runs
   `node bench/harvest.mjs --revalidate <copy>` (with the round's `--pocket` for pi-pocket-team), then adds the
   reviewed new tasks to `~/agents/<owner>/bench/<repository name>.json` (a task id appears once; an earlier
   decision stands).
3. **Grow:** `node bench/pool.mjs --grow`. Calibration and stage 1 stay; the new kept tasks join the end of R as 1
   entry of `stage2.rounds`.
4. **Branch:** `node bench/analyze.mjs --branch` with every input manifest, as above. Commit `branch.json`,
   `branch.md` and 1 row in the table below.
5. **Branch not `wait`:** run the simulation for the threshold: `node bench/analyze.mjs --simulate` with
   `--discordance <d>` and `--out bench/results/simulation.json` (tier sizes 30 and 60, the smallest and the largest
   n of a group); then stage 2 by the branch (B1, the shortlist and C1 of each group), then `--stage 2`. Record H1 to
   H3, B, the picks, the constant policy and the live experiment's pre-registration in this phase.
    - The discordance `d` (a reading of `bench/analyze.mjs`, which says to run the simulation again with stage 1's
      discordance): the highest share of discordant pairs against B1, over the confirmed groups' other models, on
      each group's stage 1 tasks (the `vsB1` cells of `bench/results/stage1/summary.json`), but never below the
      default 0.2. The simulated true gap is 15 points, and the discordance can never be below the gap. The only
      group with another model is easy alone: there, Luna has 1 discordant pair of 15 and DeepSeek 0 of 15, so `d`
      is 0.2. A merged group or the constant branch runs Opus alone and compares no model with it. `pB` stays at
      its default 0.7. The round's row records `d`.

| Round       | Run on         | Harvest window           | New kept | R   | easy | medium | hard | Branch | d       |
| ----------- | -------------- | ------------------------ | -------- | --- | ---- | ------ | ---- | ------ | ------- |
| 0 (pool v1) | 2026-11-10     | 2026-09-01 to 2026-11-06 | 70       | 22  | 11   | 11     | 0    | `wait` | not run |
| 1           | due 2026-12-01 | 2026-11-07 to 2026-11-30 |          |     |      |        |      |        |         |
| 2           | due 2027-01-01 | 2026-12-01 to 2026-12-31 |          |     |      |        |      |        |         |

Round 0's "New kept" is the whole pool (70 kept tasks, 22 of them in R). Round 2 is the last: if R is still under 30
after it, stage 1 is reported as exploratory on 2027-01-31 at the latest, and no live change follows.

## Phase 5 — Router v3

- The model router takes the stage 2 decisions: each confirmed tier's pick, or the constant policy, or today's policy
  where the bench decided nothing.
- **Built (plan T1064, task t14; the module's API version 4):** an eligible shift records `tierRule: "v1"` and its band
  from `router-rule-v1.json` (a copy of `bench/rule-v1.json`); mode `assign` beside `off` and `shadow` (the default stays
  `shadow`); the setting `liveTiers` (empty by default); arm A or B by the first byte of SHA-256(desk thread id); and
  the goal field `workerThinking`. `RULE_PICKS` ships empty, because the branch is `wait`: no band has a pick or a
  control, so no route gets an assignment. A round that decides a band fills `RULE_PICKS` (or `router.json`'s
  `ruleV1.picks`), with the control counted as section Rollout of the plan says, and writes the live experiment's
  pre-registration above, before Brian sets `assign`. See
  [model-router.md](../modules/model-router.md#rule-v1-and-assign-mode).
- **Done when:** [model-router.md](../modules/model-router.md) documents the v3 tiers with the bench's evidence, and
  the router routes by them.

## Later / ideas

- A second pool version (`bench/pool-v2.json`) only with a new pre-registration; v1 stays frozen.

## Open questions

- **R under 30** (settled 2026-11-10): the monthly rounds of phase 4, on 2026-12-01 and 2027-01-01, and the
  deadline of 2027-01-31.

## References

- Implements: [bench/README.md](../../bench/README.md) (the scripts), [modules/model-router.md](../modules/model-router.md)
  (the router that takes the result)
- Reads: [modules/daily-audit.md](../modules/daily-audit.md) (R2, which measures the routed threads after router v3)
- Label rules: [bench/calibration-labels.md](../../bench/calibration-labels.md)
- Judge calibration record: [bench/judge-calibration.md](../../bench/judge-calibration.md)
