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

## Real deliveries

`real/` holds real deliveries of the 2 GitHub Apps (`frostyard`, `bketelsen`), for the replay tests ("Real deliveries"
in `github-hooks.test.ts`, "real deliveries replay" in `github-hooks-pocket.test.ts`). Both tests fail when the folder
is absent or empty. `realDeliveries()` in `github-hooks-fixture.ts` reads them and checks their shape.

- Source: a person copies each delivery from the App's "Recent Deliveries" page on GitHub (the request headers and the
  payload), and says where it came from in `source`.
- 1 JSON file for each delivery, `real/<name>.json`, read in name order:

    ```json
    {
        "source": "<App name>, Recent Deliveries, <date>",
        "headers": {
            "Content-Type": "application/json",
            "User-Agent": "GitHub-Hookshot/…",
            "X-GitHub-Delivery": "…",
            "X-GitHub-Event": "…",
            "X-GitHub-Hook-ID": "…",
            "X-GitHub-Hook-Installation-Target-ID": "…",
            "X-GitHub-Hook-Installation-Target-Type": "integration"
        },
        "payload": {},
        "expect": { "status": 202, "outcome": "accepted", "fact": {} }
    }
    ```

- `expect.outcome` is `accepted` (`202`), `ignored` (`200`), `unprocessable` (`422`) or `ping` (`200`). `expect.fact`
  is the `fact` of the live `x.github-hooks.deliveries` log entry of the same delivery id, with no `at` field. Only an
  `accepted` delivery has a `fact`; `ping` has none (the module records only its log line).
- No signature is kept: the loader refuses a file with `X-Hub-Signature` or `X-Hub-Signature-256`. The tests sign the
  body again with a test secret, over the exact bytes they send (`JSON.stringify(payload)`).
- The repositories stay as they are: a real payload has owner `frostyard` or `bketelsen` already.
- `placeholder.pull_request.labeled.json` and `placeholder.ping.json` are not real deliveries (`source` says so): they
  are made from the examples above, with the repository `bketelsen/pi-pocket-team` and a random delivery id, and the
  `expect.fact` that `buildFact` gives. Replace them with real files.
