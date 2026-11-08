# Judge calibration: the record

The record of the judge calibration of the router bench (the T1064 plan, section Scoring, "Judge calibration"): the
development rounds, the prompt changes with their numbers, the freeze, the held-out test and the spend. The instrument
is in [README.md](README.md), section "Calibration"; the owners' label rules are in
[calibration-labels.md](calibration-labels.md); the order of the work is in
[docs/plans/router-bench.md](../docs/plans/router-bench.md), phase 2.

The judges: `openai/gpt-6.1-sol` (Sol) and `github-copilot/claude-opus-5.5` (Opus), thinking `high`, no tools. A
verdict is pass when the grade is 3 or more; the S3 rule is pass when both grades are 3 or more. A judge passes a set
with agreement on ceil(0.8 x counted) items or more and Cohen's kappa 0.6 or more; S3 passes with a false-pass rate (an
S3 pass on an owner fail) of 20% or less. Bounds are 80% Wilson intervals.

## The items

59 items in 5 owner packs (`<data>/calibration-v2/packs/`): sheeana 12, irulan 12, lucilla 12, duncan 12, teg 11 (1
fleet slot is missing after its replacements). No item is marked `blind: false`, so every item counts.

| Set      | Counted | Owner passes | Owner fails |
| -------- | ------- | ------------ | ----------- |
| Dev      | 20      | 12           | 8           |
| Held-out | 39      | 26           | 13          |

The held-out set meets the minimums (36 or more counted, 10 or more owner fails and passes), so it needed no top-up.

## Development rounds

The plan allows 2 prompt changes on the dev items, then a freeze. Each round graded the same 20 items; the numbers
decide nothing on their own.

| Round | Prompt        | SHA-256 (12)   | Rater | Agree (of 20, need 16) | Kappa | False pass (of 8)    | False fail (of 12)   | Pass |
| ----- | ------------- | -------------- | ----- | ---------------------- | ----- | -------------------- | -------------------- | ---- |
| 1     | `judge-v1.md` | `226b28d93da0` | Sol   | 15                     | 0.528 | 0 (0.0%; 0.0-17.0)   | 5 (41.7%; 25.5-59.8) | no   |
| 1     |               |                | Opus  | 17                     | 0.706 | 0 (0.0%; 0.0-17.0)   | 3 (25.0%; 12.7-43.3) | yes  |
| 1     |               |                | S3    | 15                     | 0.528 | 0 (0.0%; 0.0-17.0)   | 5 (41.7%; 25.5-59.8) | yes  |
| 2     | `judge-v2.md` | `10f8f2c2ea89` | Sol   | 14                     | 0.318 | 5 (62.5%; 40.3-80.5) | 1 (8.3%; 2.5-24.2)   | no   |
| 2     |               |                | Opus  | 18                     | 0.783 | 2 (25.0%; 10.9-47.6) | 0 (0.0%; 0.0-12.0)   | yes  |
| 2     |               |                | S3    | 17                     | 0.681 | 2 (25.0%; 10.9-47.6) | 1 (8.3%; 2.5-24.2)   | no   |
| 3     | `judge-v3.md` | `23c5c31c42ef` | Sol   | 17                     | 0.706 | 0 (0.0%; 0.0-17.0)   | 3 (25.0%; 12.7-43.3) | yes  |
| 3     |               |                | Opus  | 19                     | 0.894 | 1 (12.5%; 3.8-34.0)  | 0 (0.0%; 0.0-12.0)   | yes  |
| 3     |               |                | S3    | 17                     | 0.706 | 0 (0.0%; 0.0-17.0)   | 3 (25.0%; 12.7-43.3) | yes  |

### Round 1: `judge-v1.md`

The prompt of the plan: the rubric (0 to 4) and the reference diff as "1 accepted solution, not the only one". Every
miss was a false fail (Sol 5, Opus 3). The judges graded a defect by its symptom, not by the size of its fix: a CI
change with a 1-line defect (the new job cannot run as submitted) got grade 0 ("the build breaks") from Sol, where the
owner's label rule calls a fix of a few lines in the same approach "minor", so pass. The judges also held a design
that does the brief's task, with a stated limit, to the reference's edge cases (grade 2), where the owner judged the
limit acceptable.

### Change 1: `judge-v2.md`

The prompt took the owners' label rule ([calibration-labels.md](calibration-labels.md)): the line between grade 2 and
3 is "would you merge this after a short fix round of your own", and a minor fix is defined (same approach, a few
lines, 30 minutes or less, no correctness, security or data-loss defect and no requirement of the brief left out). New
rules: grade a defect by its fix, not its symptom (grade 0 only when the build breaks beyond a minor fix); the author's
design choices count, and an edge case that the brief does not ask for does not lower the grade; the steps of the
brief that need a PR, CI or a host are not requirements in the sandbox. The rubric's 5 grades keep their meaning.

Result: the false fails fell (Sol 5 to 1, Opus 3 to 0), but Sol now passed 5 of the 8 owner fails. In its reasons, a
change that fixed another cause than the one the brief names, a pinned version other than the one the brief names, and
a demo the brief asks for that was only partly there each became "a minor fix away": the missing work was short to
write, so the judge called it minor.

### Change 2: `judge-v3.md`

2 rules on top of version 2: a minor fix repairs what the author built and never adds what the author missed (a change
that does not solve the problem the brief names, or leaves out, contradicts or only partly meets a stated requirement,
is grade 2 or lower, even when the missing piece is short); and all the fixes count together (more than 30 minutes, or
more than a few places, is grade 2 or lower). The steps ask the judge to list the brief's requirements first and check
the change against each.

Result: both judges pass the dev set, and the S3 rule has no false pass on the dev set. This is the best round on every
line but Sol's false-fail rate (1 of 12 in round 2, 3 of 12 here), and the only round in which both judges and S3
pass.

## The freeze

`bench/judge-v3.md` is the frozen prompt: `JUDGE_PROMPT` in `bench/lib/judge.mjs` names it, and

```
JUDGE_PROMPT_SHA256 = 23c5c31c42ef09ca72dc4365d50779951c86c4339c6639caae2f4203d7872fb9
```

`bench/judge.test.mjs` fails when the file and the hash differ. The freeze was committed (`2745e58`) and pushed before any held-out call.
`judge-v1.md` and `judge-v2.md` stay as the record; no stage scores with them.

## The held-out test

Run once on 2026-11-08 with the frozen prompt (`node bench/judge-calibration.mjs --set held-out`, exit 0), 78 judge
calls, no verdict pending. Result: **PASS** (the set is valid, both judges pass, and S3 passes).

| Rater | Counted | Agree (need 32) | Kappa | False pass (of 13), 80% bounds | False fail (of 26), 80% bounds | Pass |
| ----- | ------- | --------------- | ----- | ------------------------------ | ------------------------------ | ---- |
| Sol   | 39      | 34              | 0.737 | 0.0% (0), 0.0% to 11.2%        | 19.2% (5), 11.3% to 30.8%      | yes  |
| Opus  | 39      | 37              | 0.889 | 0.0% (0), 0.0% to 11.2%        | 7.7% (2), 3.2% to 17.2%        | yes  |
| S3    | 39      | 34              | 0.737 | 0.0% (0), 0.0% to 11.2%        | 19.2% (5), 11.3% to 30.8%      | yes  |

Every miss is a false fail: the judges are stricter than the owners, never more lenient. 2 items are a fail for both
judges (an owner pass with a missing test, and an owner pass with a short text gap that the judges called a missing
requirement); 3 more are a fail for Sol only. S3 takes Sol's misses, so on these items about 1 in 5 owner passes is an
S3 fail (80% bounds 11% to 31%). For the bench this means S3 undercounts passes, the same for every model, and it does
not pass work that an owner would fail on this sample.

The result file is `<data>/calibration-v2/judge-results/held-out-23c5c31c42ef.json`.

## The label check

Each owner labelled 12 items in about 2 minutes, so the notes were read for signs of a careless pass before the
held-out run (no label was changed):

- No label contradicts its own note: each fail note names a defect that is not minor or a missing requirement, and
  each pass note names only fixes that it calls minor.
- The notes are specific to their item (versions, file names, line lengths, the exact defect); median length 181 to
  382 characters per owner, none empty.
- 3 Irulan items have the same note, and 2 pairs of Duncan items share 1 sentence: each is an item with no code change
  (no diff, or only a report file), where the same words are correct.
- 1 Duncan note refers to "the other attempts" of its task; the label rules ask for each item on its own. The note
  gives its own reason as well, and the label agrees with it.
- Sheeana's 8 held-out items are all owner passes; the class minimums hold over the whole set.

## Spend (list price, stage `calibration`)

| What                                        | List cost  |
| ------------------------------------------- | ---------- |
| Dev round 1 (`judge-v1.md`, 40 judge calls) | $2.05      |
| Dev round 2 (`judge-v2.md`, 40 judge calls) | $2.17      |
| Dev round 3 (`judge-v3.md`, 40 judge calls) | $2.20      |
| Held-out (`judge-v3.md`, 78 judge calls)    | $6.10      |
| **This task (t25)**                         | **$12.52** |

The stage `calibration` in the budget ledger: $42.79 before these rounds (the first instrument's run, the 48 attempts
and their checks), $55.31 after. The whole bench: $83.45 settled of $3,000.
