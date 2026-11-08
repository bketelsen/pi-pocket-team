# Plan: router bench

The router bench measures the candidate worker models on replays of merged tasks (cost, tokens, wall time and
quality), and turns the result into the tiers of the next model router (router v3, [model-router.md](../modules/model-router.md)).
The bench's pre-registration fixes every rule, number and seed before any paid run; this plan puts the work in order
and records what each step settled. The scripts and their data are in [bench/README.md](../../bench/README.md). After
router v3, the daily audit's R2 check measures the routed threads end to end ([daily-audit.md](../modules/daily-audit.md)).

Status: phase 1 done (pi-pocket-team#164); phase 2 done: the judges passed the held-out test (2026-11-08).

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

## Phase 5 — Router v3

- The model router takes the stage 2 decisions: each confirmed tier's pick, or the constant policy, or today's policy
  where the bench decided nothing.
- **Done when:** [model-router.md](../modules/model-router.md) documents the v3 tiers with the bench's evidence, and
  the router routes by them.

## Later / ideas

- A second pool version (`bench/pool-v2.json`) only with a new pre-registration; v1 stays frozen.

## Open questions

- **R under 30:** stage 2 waits until `--grow` brings R to 30 or more. What decides it: how often the owners review
  new harvests; by phase 4.

## References

- Implements: [bench/README.md](../../bench/README.md) (the scripts), [modules/model-router.md](../modules/model-router.md)
  (the router that takes the result)
- Reads: [modules/daily-audit.md](../modules/daily-audit.md) (R2, which measures the routed threads after router v3)
- Label rules: [bench/calibration-labels.md](../../bench/calibration-labels.md)
- Judge calibration record: [bench/judge-calibration.md](../../bench/judge-calibration.md)
