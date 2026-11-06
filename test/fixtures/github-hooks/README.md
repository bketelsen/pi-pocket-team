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
