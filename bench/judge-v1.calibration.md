# Judge v1: freeze and calibration

This file records the freeze of the judge prompt `bench/judge-v1.md` and the result of its calibration. The judges
score bench attempts (S3, `bench/score.mjs`) only with this prompt, and only after both judges pass both sets below.

## Freeze

- Prompt: `bench/judge-v1.md`.
- SHA-256: `226b28d93da03b2879a9fc2a23bb386ea899b07ce4a673754d787f63f9cde0ce` (`JUDGE_PROMPT_SHA256` in
  `bench/lib/judge.mjs`).
- `runJudge` refuses to judge when the file's hash differs: "bench/judge-v1.md changed after its freeze; a changed
  rubric is judge-v2.md and needs a new calibration". `bench/judge.test.mjs` checks the hash.
- Frozen on: TBD (the date of the merge).

## Judges

| Judge                            | Family    | Route                                                                                  |
| -------------------------------- | --------- | -------------------------------------------------------------------------------------- |
| `openai/gpt-6.1-sol`             | openai    | OpenAI                                                                                 |
| `github-copilot/claude-opus-5.5` | anthropic | GitHub Copilot (the route `anthropic/claude-opus-5-5` returns HTTP 400 for the Pi CLI) |

Each judge runs the Pi CLI in the sandbox with no tool, at thinking `high`, 3 tries, $1 reserved per try.

## Calibration inputs

- Sets: `node bench/calibration.mjs` (seed 1064), from the daily audit's blocking review points. Folder: TBD.
- Brief: the delegation brief of the PR's desk thread (a night shift's goal, else the task of the thread's first
  message). A PR is eligible only when exactly 1 desk thread names it, that thread names exactly 1 PR, and it has a
  brief. The PR title and body are never used.
- No reference: the judges get no merged change (the note "No merged change is given for this item: grade the
  submitted change by the task and the repository alone." and the diff "(none)").
- No S1 or S2: both are "not run for this item". The owners who labelled the held-out set saw only the brief and the
  diff, and the judges get the same.
- Cut: a diff over 60,000 characters is cut: its non-test file sections first, then its test file sections (each
  group in its original order; a quoted git path is decoded first), then the stat and the first 60,000 characters.
  The reorder keeps each section's text; it can add 1 newline between sections.
- Resume: a saved verdict is used again only when the judge, the item id, the part, the rubric hash and the hash of
  the rendered prompt all match.
- Run: `node bench/judge-calibration.mjs`; results in `<calibration folder>/results-v1.json`.

## Thresholds

- Development set: 20 pairs (the diff at a Not-ready head and the diff at the merged head of 1 PR, from the same
  base). A judge passes when it grades the merged diff strictly higher in 15 or more of the 20 pairs.
- Held-out set: 40 diffs, 8 per owner, labelled pass or fail by the repository owners. A judge's pass is a grade of 3
  or more. A judge passes when its pass agrees with the owner's label on ceil(0.8 x counted) or more of the counted
  items (32 of 40 with no exclusion). The set must hold exactly 40 items before exclusions; with fewer, no judge
  runs and it does not pass.
- Excluded items: TBD (with the reason for each).

## Development set

| Judge                            | Pairs | Merged higher | Ties | Lower | Pending | Pass |
| -------------------------------- | ----- | ------------- | ---- | ----- | ------- | ---- |
| `openai/gpt-6.1-sol`             | TBD   | TBD           | TBD  | TBD   | TBD     | TBD  |
| `github-copilot/claude-opus-5.5` | TBD   | TBD           | TBD  | TBD   | TBD     | TBD  |

## Held-out set

| Judge                            | Counted | Agree | Threshold | Pass | All items agree | Owner pass: judge pass / fail | Owner fail: judge pass / fail | Pending |
| -------------------------------- | ------- | ----- | --------- | ---- | --------------- | ----------------------------- | ----------------------------- | ------- |
| `openai/gpt-6.1-sol`             | TBD     | TBD   | TBD       | TBD  | TBD             | TBD                           | TBD                           | TBD     |
| `github-copilot/claude-opus-5.5` | TBD     | TBD   | TBD       | TBD  | TBD             | TBD                           | TBD                           | TBD     |

Judge spend: TBD
