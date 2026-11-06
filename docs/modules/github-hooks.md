# GitHub hooks

GitHub webhook deliveries wake the desk early. The module `github-hooks.ts` owns a small `node:http` listener on `0.0.0.0:8790`. It verifies each delivery, keeps only pattern-checked facts, records them in its own documents, and hands them to the desk's `nudge`. No GitHub text reaches a prompt: a fact holds no title, body, comment, branch name (other than `main` and `master`), URL or HTML. The desk then reads GitHub itself in an early sync; the fact only decides when to read. The 10-minute sweep stays the truth and the fallback.

The design is the plan T1013 ("GitHub webhooks into Pi Pocket"); the desk's side is the `nudge` API in [desk.md](desk.md) ("Nudges from GitHub webhooks", "Observed changes"). The public path (`https://hooks.ketelsen.cloud/github` through caddy on `10.0.1.234`) and the nftables rule on the team VM belong to fleet.

GitHub's documentation for this module:

- [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries): `X-Hub-Signature-256`, HMAC-SHA256 of the raw body.
- [Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries): GitHub does not redeliver a failed delivery by itself.
- [Redelivering webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks): a manual redelivery, in the past 3 days, keeps the same `X-GitHub-Delivery`.
- [Best practices for using webhooks](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks): answer within 10 seconds.
- [Making a GitHub App public or private](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/making-a-github-app-public-or-private): a private App installs only on the account that owns it, so there are 2 Apps (`frostyard`, `bketelsen`) with the same URL and secret.

## Start it once

1. Brian makes the secret file (below), installs the module, and turns it on in Menu → Extensions. No restart.
2. The owner runs `/github-hooks start` once, in any session. It starts the durable receiver task `x.github-hooks.receiver` in that session (a background task) and records it in `x.github-hooks.receiver`. A second `start` while a receiver task is live is refused, with the task and its session. Until a receiver runs, every delivery that passed the checks gets `503` and raises `receiver-missing`.
3. `/github-hooks` (or `/github-hooks status`) shows a plain-text card: the listener (the bound port, `retrying`, or `failed`), the receiver (task id, session, and whether it runs now), the secret (`ok`, `missing` or `short`, and whether `.next` exists; never the value), the counts by outcome, the time of the last accepted delivery, the number of pending markers, and each raised alarm. Owner only (scope `global`, and the handler checks the role).

## The receiver

A raw `node:http` handler has no Pi Durable commit, and `nudge(tx, facts, now)` needs one. So the receiver task's phase `receive` runs for a long time and does the commits for the listener. It registers itself on `globalThis[Symbol.for("pi-pocket-team.github-hooks.receiver")]` as `{ taskId, submit(job) }` and waits in-phase for the first of: a job from the listener, a tick (every 2 seconds), the module's dispose, or the abort.

- **The inbox:** at most 16 jobs at once (`INBOX_MAX`), the job whose commit runs included. A job over the bound gets `receiver-busy` (`503`) at once.
- **A job:** 1 commit for 1 delivery (below), then the answer to the listener, then the nudge commit, then the maintenance.
- **The maintenance**, after each job and at each tick, so a busy inbox never starves it: when the desk API object changed (a desk reload) or got `nudge`, hand over the pending markers. Every 10 seconds at most, write the refusals kept in memory. Every 5 minutes, evaluate the coverage alarm.
- **The back-off:** after a `nudge` that threw, no hand-over runs before 30 seconds passed, whoever asks for it (the start, a delivery, the maintenance).
- **At its start:** if `x.github-hooks.receiver` names another task, this task ends (completed). Else it hands over the pending markers and writes the refusals. A restart runs the phase again from its top: that is the recovery at load.
- **A reload of the module:** the new version loads before the old version's cleanups run, and sets a new id in `globalThis[Symbol.for("pi-pocket-team.github-hooks.version")]`. The old phase stops taking jobs, answers each waiting job `receiver-gone` (`503`), unregisters, and, because a newer version is live, commits `generation + 1` and ends. The next invocation runs the new code.
- **The module turned off:** no newer version is live (the slot keeps the old version's own id). Pi Durable keeps a running task on its old definition when the definition goes, so a phase that ended would run again at once, in a loop. So the old phase waits in memory, with no commit, until the module is on again (a new id: then it commits `generation + 1` and the new code runs) or the server restarts. A load that fails after it set its id leaves that id with no live version: a phase that runs again after a handover to an id waits for another id, so it never commits in a loop.
- **The abort** (Menu → Running now, or `abortTask`): it unregisters, answers waiting jobs `receiver-gone`, clears `x.github-hooks.receiver`, and ends `aborted`. Run `/github-hooks start` again.
- A job with no answer in 5 seconds gets `503` (`receiver-timeout`). When its commit has not started, it leaves the inbox and never commits. A commit that started can still land; a redelivery is then a duplicate (`200`).

## The listener

The load binds nothing: a timer binds after the load returns. `EADDRINUSE` retries every second for up to 30 seconds (a reloaded module starts before the old version's cleanups free the port), then stops, gives 1 error notice, and raises `bind-failed`; a later bind that works clears it. The dispose cancels a pending retry, closes the server, ends idle keep-alive sockets at once, and destroys open sockets after 2 seconds. Each listening server is in `globalThis[Symbol.for("pi-pocket-team.github-hooks.listeners")]`.

The checks, in order. Each failure ends the request, and nothing after it runs:

| Step | Check                                                                                                                                                                                                                                              | Failure                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1    | The peer (with no `::ffff:` prefix) is in `allowFrom`; at most 16 open sockets; at most 8 requests in progress; headers within 5 seconds                                                                                                           | socket closed, no answer; `408` for headers |
| 2    | `POST` and the raw `req.url` exactly `/github` (no query, no slash at the end, no encoding)                                                                                                                                                        | `404`                                       |
| 2    | `Content-Type: application/json` (a `; charset=…` parameter is fine)                                                                                                                                                                               | `415`                                       |
| 2    | `Content-Length` present (also with `Transfer-Encoding`), at most 1 MiB = 1,048,576 bytes                                                                                                                                                          | `411`, `413` before any body byte           |
| 1    | 8 MiB of bodies in memory over all requests: the length is reserved before the read                                                                                                                                                                | `503` before any body byte                  |
| 3    | The secret is `ok`                                                                                                                                                                                                                                 | `503`, alarm `secret-missing`               |
| 4    | The body within 10 seconds, at most 1 MiB                                                                                                                                                                                                          | `408`, `413`                                |
| 5    | `X-Hub-Signature-256` matches `^sha256=[0-9a-f]{64}$`, and HMAC-SHA256 of the raw bytes with the current secret, then `.next`, matches by `crypto.timingSafeEqual` on 2 buffers of 32 bytes                                                        | `401`                                       |
| 6    | `X-GitHub-Delivery` is a UUID; `X-GitHub-Event` is `pull_request`, `pull_request_review`, `check_suite`, `status`, `issues`, `ping`, `installation` or `installation_repositories`. `ping` answers `200` and records only its log line             | `400`                                       |
| 7    | Only now `JSON.parse`, then the fact. No valid repository, or an owner other than `frostyard` and `bketelsen`                                                                                                                                      | `400`, `422`                                |
| 8    | The receiver's answer: `accepted` `202`; `ignored` and `duplicate` `200`; `seen-full`, `pending-full`, `receiver-gone`, `receiver-busy` (16 jobs wait already), no receiver, or no answer in 5 seconds `503`; a failed commit `500` with no detail |                                             |

**Logs.** 1 line per delivery on the server log: `github-hooks: <time> delivery=<id> event=<event> action=<action> repo=<owner/name> outcome=<outcome> status=<status>`. A refused request before its delivery id is checked: `github-hooks: <time> refused peer=<address> reason=<outcome> status=<status>`. Never the signature, the secret, another header, or body text. Each refusal also goes into a memory buffer (500 at most; the oldest drop, counted in `dropped`) that the receiver writes into `x.github-hooks.deliveries`.

## Facts

The builder (`buildFact`, pure) keeps only these fields, each checked by its pattern; a field that fails is dropped:

- `delivery` (a UUID, lower case), `at` (the time of receipt), `event`, `action` from the event's set: `pull_request` `opened`, `closed`, `reopened`, `labeled`, `unlabeled`, `synchronize`, `ready_for_review`, `converted_to_draft`; `pull_request_review` `submitted`, `dismissed`; `check_suite` `completed`; `issues` `opened`, `closed`, `reopened`, `labeled`, `unlabeled`; `status` has no action. Another action is `ignored` (`200`): recorded as seen, with no fact and no nudge.
- `repo` from `repository.full_name`: `^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$`, owner `frostyard` or `bketelsen` (any case).
- `number` from `pull_request.number`, `issue.number` or the first `check_suite.pull_requests[].number` (all of them, at most 20, in `numbers`): an integer from 1 to 2^31-1.
- `state` (`open`, `closed`; for `status`: `pending`, `success`, `failure`, `error`), `merged`, `draft`.
- `label`: `ready-for-human`, `risk:high`, `sweep`, `agent-queue`, `agent-urgent` or `needs-plan`; another label is `"other"`.
- `review`: `approved`, `changes_requested`, `commented` or `dismissed`.
- `check`: `check_suite` `status` and `conclusion` from GitHub's documented values; for `status`, `state`.
- `sha` (`check_suite.head_sha`, `pull_request.head.sha`, `status.sha`) and `mergeSha` (`pull_request.merge_commit_sha`): 40 lower-case hex characters.
- `sender`: `^[A-Za-z0-9-]{1,39}$`; a bot login (`name[bot]`) fails the pattern and is `"bot"` when `sender.type` is `Bot`.
- `branch`: `check_suite.head_branch`, only `main` or `master`.
- `installation` and `installation_repositories` have their own schema: `installation.id`, the account (only `frostyard` or `bketelsen`, else `422`), `repository_selection` (`all` or `selected`), the action (`created`, `deleted`, `suspend`, `unsuspend`, `new_permissions_accepted`; `added`, `removed`), and the `full_name` lists (`repositories`, `repositories_added`, `repositories_removed`, each at most 500). They update the coverage list only, and give no nudge.

The desk gets `{ delivery, at, event, action, repo, number, label, sha, branch }` (the first number only).

## The delivery commit

1 commit for each delivery, all or nothing (`applyDelivery`, pure):

1. Prune `x.github-hooks.seen` by age (72 hours) only.
2. When the set is under its cap after the prune, clear `seen-full` (in this commit, a duplicate's too).
3. A known delivery id or a known body digest: `duplicate` (`200`). Only the log entry, the count and the clear above change: no fact, no marker, no nudge. The digest stops a replay under a new id: GitHub signs only the body.
4. 20000 ids within 72 hours: `seen-full` (`503`) and its alarm. No entry is ever dropped early.
5. When the desk has `nudge` now and the fact maps to a desk fact: 200 pending markers already is `pending-full` (`503`), and the commit records only the refusal (not the id).
6. Else: the id and the digest, the log entry and the count, `last`, the fact in `recent` and `repos`, the coverage alarm of that repository and class cleared, the installation list for an installation fact, and the pending marker.

With the desk off, or a desk with no `nudge`: no marker, and 1 info notice for each version of this module.

## Pending markers and `nudge`

After the answer, the receiver takes up to 500 markers, calls `desk.nudge(tx, facts, now)`, and deletes those markers in the same commit: a marker goes only in the commit where the desk took it. When `nudge` throws, that commit rolls back, the markers stay, and no try runs before 30 seconds passed, also for a new delivery. The receiver hands markers over at its start (a load or a restart: the recovery after a crash between the delivery commit and the nudge), after each delivery, and at the tick when the desk API object changed (the recovery at a desk reload). `nudge` is idempotent by delivery id, so a second hand-over changes nothing.

## The documents

All app-wide (`scope: "session"`), version 1, a full base after 64 deltas. Stored data: never rename a kind or a field, and never change what a field means.

| Kind                        | Fields                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x.github-hooks.seen`       | `ids` (delivery id → time), `digests` (SHA-256 hex of the raw body → time): 72 hours, by age only                                                                                                                                                                                                                          |
| `x.github-hooks.deliveries` | `log` (newest last, 2000 at most: `{ delivery?, at, event?, action?, repo?, outcome, status, peer?, fact? }`, checked fields only; installation repository lists left empty), `counts` (outcome → number), `last` (the last accepted delivery), `dropped` (refusals the memory buffer lost)                                |
| `x.github-hooks.pending`    | `markers` (delivery id → `{ fact, at }`): 200 at most                                                                                                                                                                                                                                                                      |
| `x.github-hooks.alarms`     | `system` (`bind-failed`, `secret-missing`, `seen-full`, `receiver-missing` → `{ raised, cleared? }`), `coverage` ("repo\|class" → `{ raised, misses, cleared? }`), `misses` ("repo\|class" → times, 24 hours), `evaluated` (observed change key → time)                                                                    |
| `x.github-hooks.coverage`   | `recent` (accepted facts of 48 hours, 20000 at most: `{ repo, number?, numbers?, sha?, class, at, event? }`; `event` is `"status"` for a `status` fact, and absent for the others and for entries stored before it), `installations` (id → `{ account, selection, repos }`), `repos` (repository → its last accepted fact) |
| `x.github-hooks.receiver`   | `task`, `conversation`, `started`: the receiver of record                                                                                                                                                                                                                                                                  |

The alarm state is split in 2 documents: `x.github-hooks.alarms` holds the alarms, and `x.github-hooks.coverage` holds what they compare against.

## Alarms

Silence alone raises nothing: no rule looks at the time since the last delivery (a quiet weekend is normal).

- **Coverage, per repository and class.** It reads `x.desk.observed` (the changes each desk sweep saw) with a read-only token; it never writes it, and a read that fails gives 1 notice and no evaluation. The class of a fact: `pull_request` `opened`, `closed`, `reopened`, `ready_for_review`, `converted_to_draft` and `issues` `opened`, `closed`, `reopened` are `state`; `labeled` and `unlabeled` are `labels`; `synchronize` is `head`; `pull_request_review` is `review`; `check_suite` and `status` are `ci`. Covered repositories: each repository of a `selected` installation, every repository of an account with an `all` installation, and each repository that sent an accepted fact in the last 30 days. Every 5 minutes, each observed change of a covered repository that is 30 minutes to 24 hours old is checked once. It matches a fact of the same repository and class, with the same number (or in `numbers`; for `ci`, also a `status` fact whose sha is the PR's observed head, or a `head` fact of the same PR; a `check_suite` fact matches by its numbers only, never by its sha), that came between 5 minutes before the change (or 6 hours before the sweep saw it, when GitHub gave no time) and 30 minutes after the sweep saw it. No match is a miss. 2 misses of 1 repository and class within 24 hours raise its alarm: 1 warning notice with the repository and the class only. Only an accepted fact of that repository and class clears it; a fact of another class or another repository does not.
- **System:** `bind-failed` (error notice; cleared by a bind that works), `secret-missing` (error; cleared when a good secret is read), `seen-full` (warning; cleared when `seen` is under its cap again), `receiver-missing` (error; cleared when a receiver registers). An alarm raised outside a commit is written by the receiver. Each raise gives 1 notice for each version of the module.

## The secret

`~/.config/pi-pocket-team/github-webhook.secret` (mode 0600), and `github-webhook.secret.next` during a rotation. Each file is read at first use and again when its inode, size or mtime changes, and trimmed. Shorter than 32 characters is `short`; empty, absent, unreadable or longer than 4096 characters is `missing`; either gives `503` for every delivery and the alarm `secret-missing`. Each value read is hidden with `host.hide` (label `github webhook secret`) until it changes or the module goes. A file with group or other permission bits gives 1 warning, and the module goes on. The secret, or any part of it, never goes in a log, a notice, an error, a document, a card or a command answer.

## Settings and environment

- `allowFrom` (Menu → Extensions): a comma list of IP addresses, default `10.0.1.234`. An invalid entry is ignored; an empty list admits nobody. A change takes effect at once, with no rebind.
- For tests only, environment variables win: `PI_POCKET_GITHUB_HOOKS_PORT` (default 8790), `PI_POCKET_GITHUB_HOOKS_HOST` (default `0.0.0.0`), `PI_POCKET_GITHUB_HOOKS_ALLOW_FROM`, `PI_POCKET_GITHUB_HOOKS_SECRET_DIR` (default `~/.config/pi-pocket-team`), `PI_POCKET_GITHUB_HOOKS_TICK_MS` (the receiver's tick, default 2000) and `PI_POCKET_GITHUB_HOOKS_BIND_RETRY_MS` (default 1000).

## What it records, and where the audit reads it

`x.github-hooks.deliveries` holds each accepted fact and each refusal (newest 2000) and the counts by outcome; `x.github-hooks.alarms` holds the system and coverage alarms with their raise and clear times. The desk's `x.desk.nudges` holds the delay from each delivery to its sync's commit. This module writes these documents and reads none of them for a report; the audit scripts in `audit/` read them.

The report `audit/github-hooks.mjs` (added 2026-11-06, for the 7-day report after go-live) reads them read-only:

```sh
node audit/github-hooks.mjs --since <ISO time or ms> [--until <ISO time or ms>] [--json]
```

`--since` is required: the go-live time. `--until` defaults to now. The window includes `--since` and excludes `--until`. It opens `$PI_POCKET_DIR/pocket.sqlite` (default `~/.pi-pocket`) with `readOnly: true`, runs no `gh`, no `git` and no network, writes no file, and prints Markdown (JSON with `--json`). A document that is not there is reported as `absent`. It reads 4 app-wide documents:

- `x.github-hooks.deliveries`: the log entries with `at` in the window, by outcome, and the `accepted` ones by event; the all-time `counts`, `dropped` and `last`. When the log holds 2000 entries and its oldest is after `--since`, it says that the log is cut.
- `x.desk.nudges`: each entry of `syncs` whose `started` is in the window. A sync with `committed` 0 counts as failed. For the others, the delay `committed - at` of each delivery: n, median, P90 and max, in seconds.
- `x.desk.observed`: each change with `at` above 0, the delay `seen - at`, by class (`state`, `labels`, `review`, `head`, `ci`), in 2 groups: the baseline (`seen` before `--since`) and after (`seen` in the window): n, median and P90. It says the oldest `seen` the document still holds (it keeps the newest 2000 changes, so the baseline is short).
- `x.github-hooks.alarms`: each system and coverage alarm with its raise and clear times, and the count of coverage misses in the window (from `misses`, which keeps 24 hours, and from each coverage alarm's own `misses`).

## Test hooks

2 global slots exist for tests only; nothing in the module sets them, and with them absent the module works the same:

- `globalThis[Symbol.for("pi-pocket-team.github-hooks.test-fail")]`: a function the delivery commit calls after its changes, inside the commit. A throw rolls the whole commit back: the listener answers `500`, and nothing of the delivery persists.
- `globalThis[Symbol.for("pi-pocket-team.github-hooks.test")]`: counters the module adds to when a test sets the object: `ticks` (receiver waits), `commits` (receiver commits), `parked` (phases now in the turn-off wait) and `parks` (turn-off waits entered). The tests wait on these, not on a time.

## Tests

`github-hooks.test.ts` runs the listener factory over loopback, with a fake receiver: each HMAC case, the size limits, admission (17 sockets, 9 requests, 9 MiB in flight), the routes, the peer check, the events, the secret states (also a secret changed in place, with the same length and inode), a held port, a dispose during a retry, and `close` with an idle socket (ended at once) and an active one (destroyed after the grace time, not before). The receiver loop has its own tests: the inbox bound of 16 jobs and the cancel of a job the listener gave up on, the nudge back-off for every caller, and the maintenance under a busy inbox. It also tests the fact builder on the `@octokit/webhooks-examples` payloads (`test/fixtures/github-hooks/`) with hostile text added, the pure delivery commit (dedupe, a full set and its clear by a duplicate, a full pending set, the desk off, installations), the coverage alarm, and the secret source. `github-hooks-pocket.test.ts` runs the module with `team.ts` and the desk in Pocket's test harness: the start command and its refusal, a delivery end to end to the desk's `nudge`, a real failed commit (by the test hook: `500`, nothing persists, then `202`), 1 reload with an idle keep-alive socket, the status card, 2 copies at once, hostile text in every document, 20 reloads (1 listener, 1 receiver), the module turned off (no commit loop) and on, a load that fails late, the desk off and on, a second nudge, and a crash between the commit and the nudge recovered after a restart. Both files also replay the real deliveries in `test/fixtures/github-hooks/real/` (copied from the Apps' "Recent Deliveries" page, with no signature; format in `test/fixtures/github-hooks/README.md`): "Real deliveries" in `github-hooks.test.ts` checks that `buildFact` gives each recorded fact or refusal, with no free text of the payload in the fact, and that the loader refuses a signature header or a missing part; "real deliveries replay" in `github-hooks-pocket.test.ts` posts each one to the live listener with its real headers and a signature made with the test secret, checks the status, the outcome and the fact in `x.github-hooks.deliveries`, then a redelivery (`200`, `duplicate`, 1 entry with a fact, 1 desk nudge), and that no free text of a payload is in any `x.github-hooks.*` document. Both fail when `real/` is absent or empty. `audit/github-hooks.test.ts` tests the report: the summary on invented documents (the window edges, a failed sync, the baseline split, a cut log, absent documents) and 1 run on a temporary database. Each test file maps the plan's Test plan in its top comment.
