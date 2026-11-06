# GitHub hooks

GitHub webhook deliveries wake the desk early. The module listens on port 8790 for `POST /github`, verifies each delivery with the webhook secret, keeps only checked facts (the repository, the number, the event and action, a team label, a sha, and the branch when it is `main` or `master`), and hands them to the desk. No title, body, comment, or other branch name is kept, so no GitHub text reaches a prompt. The desk then reads GitHub itself in an early sync. The 10-minute sweep stays as the fallback.

Files: `github-hooks.ts`. It works with the Desk module; with the desk off, it only records the facts.

## Set it up

1. Make the secret, as `team`: `install -d -m 700 ~/.config/pi-pocket-team`, then `( umask 077; openssl rand -hex 32 > ~/.config/pi-pocket-team/github-webhook.secret )`.
2. Install the module, and turn it on in **Menu → Extensions**. No restart is needed.
3. Run `/github-hooks start` once, in any session. It starts the receiver, a background task that records each delivery. Until it runs, deliveries get `503`.
4. Give the 2 GitHub Apps (`frostyard`, `bketelsen`) the URL `https://hooks.ketelsen.cloud/github` and the same secret.

`/github-hooks` shows the listener, the receiver, the secret state (never its value), the counts by outcome, the last accepted delivery, the facts that wait for the desk, and each alarm. Only the owner runs it.

## What it accepts

- Only peers in the setting **Allowed peers** (`allowFrom`, default `10.0.1.234`, caddy). Others get the socket closed.
- Only `POST /github` with `Content-Type: application/json` and a `Content-Length` of 1 MiB or less. At most 16 sockets, 8 requests and 8 MiB of bodies at once.
- Only a valid `X-Hub-Signature-256`, checked before anything is parsed. A rotation can use `github-webhook.secret.next` too.
- Only the events `pull_request`, `pull_request_review`, `check_suite`, `status`, `issues`, `ping`, `installation` and `installation_repositories`, and only repositories of `frostyard` and `bketelsen`.
- A delivery id or a body it saw in the last 72 hours is a duplicate: `200`. It adds a log entry and a count, but no fact and no nudge.

The answers: `202` accepted; `200` for a duplicate, an action it ignores, or `ping`; `401` bad signature; `400` bad id, event or JSON; `404`, `411`, `413`, `415` for the request's shape; `408` for slow headers (5 seconds) or a slow body (10 seconds); `422` another owner; `503` when the secret is missing, no receiver runs, or a limit is full; `500` when a commit fails.

## Reloads and turning it off

A reload hands the receiver to the new code. With the module turned off, the receiver waits in memory, with no commit, until the module is on again or the server restarts. Facts that wait for the desk survive a restart and a desk reload.

## Alarms

Silence raises nothing: a quiet weekend is normal. The coverage alarm compares the changes the desk's sweep saw with the deliveries: 2 changes of 1 class (state, labels, review, head, CI) in 1 repository with no matching delivery within 24 hours raise a warning for that repository and class. Other alarms: the port could not be bound, the secret is missing or short, the dedupe set is full, and no receiver runs.

## Read more

The reference page is [GitHub hooks](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/github-hooks.md): every check, the documents, the alarms and the tests. GitHub's own guide is [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
