You are a senior reviewer and a maintainer of this repository. Grade 1 submitted change against the task it was written for.

You get the task (the brief that the author got), the author's change as a diff against the repository at the start, the results of 2 automatic checks, and the diff of the change that the maintainers merged for the same task. The merged change is 1 accepted solution, not the only one: a different approach that does the task well is as good. Do not grade by how close the submission is to it; use it to understand the task, the code and what a complete answer needs.

Grade the submission by this rubric:

- 0: no change, or the build breaks and needs more than a minor fix.
- 1: wrong approach.
- 2: right approach, needs major fixes.
- 3: acceptable with minor fixes.
- 4: mergeable as it is.

The line that matters most is between 2 and 3: would you merge this change after a short fix round of your own?

- **A minor fix** keeps the same approach, touches a few lines, takes 30 minutes or less, and leaves no correctness, security or data-loss defect and no requirement of the brief out.
- **A minor fix repairs what the author built. It never adds what the author missed.** When the change does not solve the problem that the brief names (for example, it fixes another cause, or another race), or when it leaves out, contradicts or only partly meets a requirement that the brief states (a version, a name, a behaviour, a test, a demo, a doc), it is grade 2 or lower, even when the missing piece would be short to write.
- **Count all the fixes together.** When the fixes of all the defects together take more than 30 minutes, or touch more than a few places, it is grade 2 or lower.
- **Grade a defect by its fix, not by its symptom.** A defect that breaks a build, a test or a CI job as submitted is grade 3 when its fix is minor (for example, 1 wrong path, 1 wrong variable, 1 missing flag). It is grade 2 or lower only when the fix is not minor.
- **Grade 2 or lower** when the fix is not minor: a correctness, security or data-loss defect that needs real rework, a requirement of the brief left out, or an approach that does not do what the brief asks.
- **The author's choices count.** A design that is heavier, or covers fewer edge cases than the merged change, is grade 3 or 4 when it does what the brief asks and its known limits are small or stated. Do not lower the grade for an edge case or a robustness concern that the brief does not ask for and that a maintainer would accept as a follow-up.

How to decide:

1. Read the brief. List what it asks the code to do: the problem to solve, the behaviour, the values, the files, the tests and the docs it names.
2. Judge only the change in the working tree. The author worked in a sandbox: only in the repository's folder, with no commit, push or PR, and no GitHub or network for the repository. A step of the brief that needs those (open a PR, a cross-review, CI, a label, a release, running on a host, a report to a person, a worktree, a lease) is not a requirement here.
3. Read the submitted change. Use the merged change to understand the task and the code, not as the answer.
4. Weigh S1 and S2 as facts. A failed check usually means a correctness defect; the change is grade 3 only when its fix is minor. A passed check does not make a grade 3 by itself.
5. Check the change against each item of your list from step 1. Does the change solve the problem that the brief names, and meet each requirement? Then find the most serious defect, and ask: is its fix minor, and are all the fixes together minor? Then give the grade.

## The task

<brief>
{{BRIEF}}
</brief>

## The automatic checks

- S1, the repository's own check on the submitted tree: {{S1}}
- S2, the merged change's own tests that failed before it: {{S2}}

## The submitted change

{{SUBMITTED_NOTE}}

<submitted-diff>
{{SUBMITTED_DIFF}}
</submitted-diff>

## The merged change (1 accepted solution, not the only one)

{{REFERENCE_NOTE}}

<reference-diff>
{{REFERENCE_DIFF}}
</reference-diff>

## Your answer

Answer with 1 JSON object only, and nothing before or after it:

{ "grade": <an integer from 0 to 4>, "reasons": "<1 to 5 sentences: whether the change solves the problem and meets each requirement of the brief, the most serious defect and whether its fix is minor, what the submission does well, and why it gets this grade>" }
