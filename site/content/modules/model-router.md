# Model router

Every delegation can get a suggestion of the model that would suit its brief. The router sends the brief to TypeSafe Jev, which judges the work, and it records the tier and the model it would pick, with the brief's features. In the default mode `shadow` it is a record: nothing else changes. An eligible shift also gets the band of the bench's frozen rule, and in mode `assign`, on a band Brian made live, a worker.

Files: `model-router.ts`. It has no page of its own; the route goes on the desk thread.

## 3 rules

The code keeps Brian's 3 rules:

1. **Shadow unless Brian says so.** In mode `shadow` (the default) the router records its suggestion, and changes no model, no worker and no thinking level. Only in mode `assign`, on a band that Brian lists in `liveTiers`, an eligible shift gets a worker and its thinking level. The linked session always starts on the profile model, exactly as it does without the router.
2. **The brief goes to Jev masked.** URLs, emails, IP addresses, network host names, the host names in `~/.ssh/config`, and secret-like tokens become `[url]`, `[email]`, `[ip]`, `[host]` and `[secret]` before the call. A repository name such as `bketelsen/pi-pocket` and a file name such as `team.ts` stay.
3. **Every delegation, and a named worker still wins.** The router runs on every `team_delegate` delegation, a shift or not (a plan start and a Clerk start have none). When `shift.worker` names a model, that worker runs, and the route records the worker so the audit can compare the 2. Outside an assignment, the route changes no model, no worker and no tool result; a named worker always wins over an assignment.

## Settings

**Menu → Extensions → Model router**:

- **`mode`**: `off`, `shadow` (the default), or `assign`. `shadow` classifies and records. `off` records the line `Route: off (the router's mode is off); nothing changes` and calls nothing. `assign` records as `shadow` does, and assigns a worker only to an eligible shift whose band is live and has a pick.
- **`liveTiers`**: the bands (`easy`, `medium`, `hard`, comma separated) that are live in mode `assign`. Empty by default. An unknown name is ignored with a note on the route.
- **`typesafeApiKey`**: the TypeSafe API key. It is a secret setting: Pi and the browser never see it, and it shows as `[TYPESAFE_API_KEY]` in a tool result. The server sends it only to the fixed TypeSafe endpoint below, as the `Authorization` header. Without a key, a route fails with "no TypeSafe key set", and the delegation goes on as before.

The module needs Pi Pocket v0.22.0 or later for its settings. Like every new module it starts off.

## What is sent

One POST to `https://api.typesafe.ai/v1/systemone` (fixed in the code: there is no environment override, because a variable could send the key elsewhere), with `Authorization: Bearer <key>`, the masked brief as `state.request`, the model alias `jev-latest`, and 4 questions. No folder, no history, no spend, and no environment. The timeout is 3.5 s in total, there is no retry, and a failure never holds a delegation: `team.ts` gives the router 4 s, then records a failed route and goes on.

## Tiers

`~/.config/pi-pocket-team/router.json` is optional and holds no secrets. It sets the candidate models for each tier: `quick`, `standard`, `high` and `premium`, each with a model list and a thinking level. A missing file is fine; an invalid file gives the default tiers and a note on the route.

A tier may be left out: it keeps its default. Only models the owner allows for subagents are usable, and a model with a problem now is skipped; then the nearer tiers are tried. DeepSeek is skipped in its peak hours. `plan` and `review` floor at `high`; `implement`, `debug`, `refactor`, `research` and `operate` floor at `standard`.

## Rule v1 and assign mode

The bench measured the worker models on replayed tasks and froze a rule that predicts a task's band (`easy`, `medium` or `hard`) from facts known when the work starts. The module installs a copy of it, `router-rule-v1.json`.

- **Eligible:** a shift that names no worker, of the Jev kind `implement`, `debug`, `refactor` or `write`, in a bench repository, whose brief names only bench repositories and no risk path. Its route records `tierRule: "v1"` and the band. Any other delegation is routed as before. With no valid rule file, there is no band and no assignment, and a note says why.
- **Picks:** each band can have a pick (a model at a thinking level) and a control (the worker Odrade names today). The bench has decided no band yet, so the module ships with no pick and assigns nothing. A later round adds the picks, or Brian sets them in `router.json` under `ruleV1.picks`.
- **Arms:** in mode `assign`, on a live band with a pick, the desk thread's id picks the arm: arm A runs the pick at its thinking level, arm B the control. A model that cannot be used falls back to the control, then to none. The shift's worker and its thinking level are set before the session starts, and the rounds name both. The session's own model never changes.

## The record

The route goes on the desk thread as `route`, with 1 event line:

```text
Route: implement (kind 0.82), complexity 1.8/3, demand 1.9 → high: github-copilot/claude-sonnet-5.5, thinking medium (no worker named; profile: github-copilot/claude-opus-5.5; shadow, not applied)
```

With a named worker the line is shorter, and it says which model really runs. A route is stored in a memo of the tool call, so a replayed delegation reads the first answer and Jev is never asked twice.

Every new route also carries `features` (version 1) and `briefHash`, the SHA-256 of the brief: off and failed routes too. The features are Jev's judgments (absent when Jev did not answer), the brief's length, the paths and roster repositories it names, the repository's language, whether a named path is a risk path (any path of a version 1 risk-path list, or an L1 or L2 path of a version 2 list), and whether a test file sits beside a named path. They keep counts and flags, never brief text. The reference page lists each field.

The daily audit's check **R1** counts the routes of shifts only. It joins every such route with what happened: the count, the open threads, the successes, the goals' statuses, the median rounds and cost, and the reopenings, grouped by kind, suggested tier and model, status, the named worker, and the model that really ran. A success rate shows only for 10 threads or more, and R1 makes no finding. The check **R2** measures every routed thread end to end, by the arm it was assigned: whether the work was accepted (merged, not reopened for rework, and not reverted within 14 days; the rules are in the [daily audit reference](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/daily-audit.md)), the cost per accepted thread, the review rounds and hand fixes, and whether the worker that ran matched the assigned one.

## Limits

- It never picks a model for Pi, and it never asks a judge model to decide anything but the tier: the record is a suggestion.
- 1 call for each delegation, 3.5 s at most, and no retry.
- A failure is recorded as a route, never as an error to the person: the delegation goes on.

## Credit

Parts of `model-router.ts` are adapted from **pi-jev-model-router 0.9.0**, MIT License, Copyright (c) 2026 Shah Rukh. The full MIT notice is at the top of the file.

## Read more

The reference page is [Model router (shadow)](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/model-router.md), with [settings](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/model-router.md#settings), [what is sent](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/model-router.md#what-is-sent), [tiers](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/model-router.md#tiers), [features](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/model-router.md#features) and [the record](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/model-router.md#the-record).
