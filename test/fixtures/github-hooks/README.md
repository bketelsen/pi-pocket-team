# GitHub webhook fixtures

Example payloads for the tests of `github-hooks.ts` (`github-hooks.test.ts`, `github-hooks-pocket.test.ts`).

- Source: the npm package `@octokit/webhooks-examples`, version 7.6.1 (MIT), file `api.github.com/index.json`,
  fetched with `npm pack @octokit/webhooks-examples@7.6.1` on 2026-11-06.
- The package has no license file of its own. `LICENSE` here is the license of its source repository,
  `octokit/webhooks` (MIT, Copyright (c) 2018 Gregor Martynus).
- Each file is the first example of the package for 1 event and action, unchanged, written with 4-space indents:
  `pull_request` `opened`, `closed`, `reopened`, `labeled`, `unlabeled`, `synchronize`, `ready_for_review` and
  `converted_to_draft`; `pull_request_review` `submitted` and `dismissed`; `check_suite` `completed`; `status`;
  `issues` `opened`, `reopened`, `labeled` and `unlabeled`; `installation` `created`;
  `installation_repositories` `added`; and `ping`.
- The package has no `issues` `closed` example. The tests make one from `issues.reopened.json`.
- The tests move each repository to an allowed owner, and add hostile text, in the test code. The files hold no
  hostile text and no signature.

## Live deliveries

`live/` holds 1 fixture for each kind of delivery that the live module recorded on 2026-11-06, for the replay tests
("Live deliveries" in `github-hooks.test.ts`, "live deliveries replay" in `github-hooks-pocket.test.ts`). Both tests
fail when the folder is absent or empty. `liveDeliveries()` in `github-hooks-fixture.ts` reads them and checks their
shape.

- The fixtures are synthetic: copies of GitHub's payloads were not taken. Each file mirrors 1 delivery of the live
  `x.github-hooks.deliveries` log (1 for each event and action that came, both installations, and 1 `ping`), which
  keeps only checked facts, no free text.
- How each file was made: start from the example of the same event and action above (`<event>.<action>.json`, or
  `ping.json`). Set every field that the fact builder reads to the live value: the repository `full_name`,
  `owner.login` and `name`; the PR number, `state`, `merged`, `draft`, `head.sha` and `merge_commit_sha` (`null` when
  the live fact has no `mergeSha`; `merged` and `draft` are removed when the live fact has none); the label name; the
  review state; the check suite `status`, `conclusion`, `head_sha`, `head_branch` and `pull_requests[].number`; the
  sender login (type `User`); the installation `id`, account login, `repository_selection` and `repositories` (from
  the live `x.github-hooks.coverage` list, as the log keeps it empty). The free text of the example stays as it is.
- The file name is `<event>.<action>.<first 8 characters of the delivery id>.json` (`ping.<id>.json` for `ping`).
- The format:

    ```json
    {
        "source": "synthetic: @octokit/webhooks-examples <file>, set to the checked fields of live delivery <id> (2026-11-06)",
        "headers": {
            "Content-Type": "application/json",
            "User-Agent": "GitHub-Hookshot/synthetic",
            "X-GitHub-Delivery": "<the live delivery id>",
            "X-GitHub-Event": "<event>",
            "X-GitHub-Hook-ID": "0",
            "X-GitHub-Hook-Installation-Target-ID": "0",
            "X-GitHub-Hook-Installation-Target-Type": "integration"
        },
        "payload": {},
        "expect": { "status": 202, "outcome": "accepted", "fact": {} }
    }
    ```

    The 2 hook ids are `0`: the live log does not keep them.

- `expect` is what the live module recorded: the status and the outcome, and for an `accepted` delivery the `fact` of
  its log entry with no `at` field (for an installation, with the repository lists empty, as the log keeps them).
  `ping` has no `fact`: the module records only its log line. `expect.outcome` is `accepted` (`202`), `ignored`
  (`200`), `unprocessable` (`422`) or `ping` (`200`).
- No signature and no secret is kept: the loader refuses a file with `X-Hub-Signature` or `X-Hub-Signature-256`. The
  tests sign the body with a test secret, over the exact bytes they send (`JSON.stringify(payload)`).
- The repositories stay as they are: each payload has owner `frostyard` or `bketelsen`, as its live delivery had.
