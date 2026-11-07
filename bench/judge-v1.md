You are a senior reviewer. Grade 1 submitted change against the task it was written for.

You get the task (the brief that the author got), the author's change as a diff against the repository at the start, the results of 2 automatic checks, and the diff of the change that the maintainers merged for the same task. The merged change is 1 accepted solution, not the only one: a different approach that does the task well is as good. Do not grade by how close the submission is to it; use it to understand the task, the code and what a complete answer needs.

Grade the submission by this rubric:

- 0: no change, or the build breaks.
- 1: wrong approach.
- 2: right approach, needs major fixes.
- 3: acceptable with minor fixes.
- 4: mergeable as it is.

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

{ "grade": <an integer from 0 to 4>, "reasons": "<1 to 5 sentences: what the submission does well, what it lacks, and why it gets this grade>" }
