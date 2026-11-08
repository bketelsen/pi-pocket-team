# Calibration labels

The rules for the owners' labels of the judge calibration (the T1064 plan, section Scoring, "Judge calibration"). An
owner labels the items of its pack pass or fail. The labels calibrate the 2 judges of the replay bench (S3): each
judge's verdict is compared with them. No label decides a bench attempt.

These rules are fixed before any pack goes out. A change to them is a new file and a new calibration.

## What an item is

1 item is 1 attempt of 1 model on 1 bench task of your repositories: a real merged task, replayed from its parent
commit with its delegation brief. The item shows exactly what the judges see, and nothing else:

- **The task:** the delegation brief that the author got.
- **The automatic checks:** S1, the repository's own check on the submitted tree; S2, the merged change's own tests
  that failed before it (or "none" when the task has no such test).
- **The submitted change:** the author's diff against the parent commit. A diff over 60,000 characters is cut: you get
  its stat and its first 60,000 characters, code files before test files.
- **The merged change:** the diff that the maintainers merged for the same task. It is 1 accepted solution, not the
  only one.

The item does not show which model wrote the change, its cost, its time or its tries. The 4 items of 1 task are in a
seeded order among the others.

## The label

- **pass:** a maintainer of the repository would merge the change as it is, or after minor fixes. Minor fixes keep
  the same approach, touch a few lines, take 30 minutes or less, and leave no correctness, security or data-loss
  defect and no requirement of the brief out. This is grade 3 or 4 of the judges' rubric.
- **fail:** anything else: no change, a build that breaks, a wrong approach, a right approach that needs major fixes,
  a correctness, security or data-loss defect, or a requirement of the brief left out. This is grade 0 to 2.

How to decide:

1. Read the brief. Note what it asks the code to do: the behaviour, the files, the tests and the docs it names.
2. Judge only the change in the working tree. The author worked in a sandbox under the bench header: only in the
   repository's folder, with no commit, push or PR, and no GitHub or network for the repository. A step of the brief
   that needs those (open a PR, a cross-review, CI, a label, a release, running on a host, a report, a worktree, a
   lease) is not a requirement here.
3. Read the submitted change. Use the merged change to understand the task and the code, not as the answer: a
   different approach that does the task well is a pass.
4. Weigh S1 and S2 as facts. A failed check usually means a correctness defect; the item is a pass only when its fix
   is minor by the rule above. A passed check does not make a pass by itself.
5. When you hesitate between pass and fail, ask: "would I approve this PR after a short fix round of my own?" Yes is
   pass, no is fail.

Label each item on its own. Do not compare the 4 items of a task to rank them: 4 passes or 4 fails are fine.

## Blind

The labels count only when they are blind. When you saw an item's change before (its diff, its run, its scores, or
a review of it), set `blind` to `false` and say how in `reason`. Such an item leaves every count. Give it a label all
the same.

Open only your pack folder and this file. Do not open:

- the keys (`keys/`), the plan (`plan.json`), or the `results/`, `runs/`, `diffs/`, `score/` and `judges/` folders of
  the bench data dir (`~/.local/share/pi-pocket-team/bench/`);
- another owner's pack;
- the task's GitHub PR, its desk thread, or the merged commit's later history.

Do not talk about the items with another owner until every pack is labelled.

## How to record a label

Your pack is `~/.local/share/pi-pocket-team/bench/calibration-v2/packs/<owner>/`. It holds `README.md`, `items/`
(1 Markdown file per item), `items.json` and `labels.json`. Change only `labels.json`; for each item set:

- `label`: `"pass"` or `"fail"`;
- `note`: 1 to 3 sentences: why (the defect, the missing requirement, or why the fixes are minor);
- `blind`: `true`, or `false` when you saw the item before;
- `reason`: empty, or how you saw it when `blind` is `false`.

Keep `id` and `set` as they are. `bench/judge-calibration.mjs` refuses a pack whose `items.json` changed after it was
written, a label other than `pass` or `fail`, and `blind: false` without a reason.

## References

- The instrument and the run: [README.md](README.md), section "Calibration".
- The judges' prompt and rubric: [judge-v1.md](judge-v1.md).
- The order of the work: [docs/plans/router-bench.md](../docs/plans/router-bench.md), phase 2.
