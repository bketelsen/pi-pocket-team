# Model router

Every delegation can get a suggestion of the model that would suit its brief. The router sends the brief to TypeSafe Jev, which judges the work, and it records the tier and the model it would pick, with the brief's features. It is a record: nothing else changes.

Files: `model-router.ts`. It has no page of its own; the route goes on the desk thread.

## 3 rules

The code keeps Brian's 3 rules:

1. **Shadow mode only.** The router records its suggestion. It never changes a model, a worker, or a thinking level. The linked session still starts on the profile model, exactly as it does without the router.
2. **The brief goes to Jev masked.** URLs, emails, IP addresses, network host names, the host names in `~/.ssh/config`, and secret-like tokens become `[url]`, `[email]`, `[ip]`, `[host]` and `[secret]` before the call. A repository name such as `bketelsen/pi-pocket` and a file name such as `team.ts` stay.
3. **Every delegation, and a named worker still wins.** The router runs on every `team_delegate` delegation, a night shift or not (a plan start and a Clerk start have none). When `night_shift.worker` names a model, that worker runs, and the route records the worker so the audit can compare the 2. The route changes no model, no worker and no tool result.

## Settings

**Menu → Extensions → Model router**:

- **`mode`**: `off`, or `shadow` (the default). `shadow` classifies and records. `off` records the line `Route: off (the router's mode is off); nothing changes` and calls nothing.
- **`typesafeApiKey`**: the TypeSafe API key. It is a secret setting: Pi and the browser never see it, and it shows as `[TYPESAFE_API_KEY]` in a tool result. The server sends it only to the fixed TypeSafe endpoint below, as the `Authorization` header. Without a key, a route fails with "no TypeSafe key set", and the delegation goes on as before.

The module needs Pi Pocket v0.22.0 or later for its settings. Like every new module it starts off.

## What is sent

One POST to `https://api.typesafe.ai/v1/systemone` (fixed in the code: there is no environment override, because a variable could send the key elsewhere), with `Authorization: Bearer <key>`, the masked brief as `state.request`, the model alias `jev-latest`, and 4 questions. No folder, no history, no spend, and no environment. The timeout is 3.5 s in total, there is no retry, and a failure never holds a delegation: `team.ts` gives the router 4 s, then records a failed route and goes on.

## Tiers

`~/.config/pi-pocket-team/router.json` is optional and holds no secrets. It sets the candidate models for each tier: `quick`, `standard`, `high` and `premium`, each with a model list and a thinking level. A missing file is fine; an invalid file gives the default tiers and a note on the route.

A tier may be left out: it keeps its default. Only models the owner allows for subagents are usable, and a model with a problem now is skipped; then the nearer tiers are tried. DeepSeek is skipped in its peak hours. `plan` and `review` floor at `high`; `implement`, `debug`, `refactor`, `research` and `operate` floor at `standard`.

## The record

The route goes on the desk thread as `route`, with 1 event line:

```text
Route: implement (kind 0.82), complexity 1.8/3, demand 1.9 → high: github-copilot/claude-sonnet-5.5, thinking medium (no worker named; profile: github-copilot/claude-opus-5.5; shadow, not applied)
```

With a named worker the line is shorter, and it says which model really runs. A route is stored in a memo of the tool call, so a replayed delegation reads the first answer and Jev is never asked twice.

Every new route also carries `features` (version 1) and `briefHash`, the SHA-256 of the brief: off and failed routes too. The features are Jev's judgments (absent when Jev did not answer), the brief's length, the paths and roster repositories it names, the repository's language, whether a named path is a risk path, and whether a test file sits beside a named path. They keep counts and flags, never brief text. The reference page lists each field.

The daily audit's check **R1** counts the routes of night shifts only. It joins every such route with what happened: the count, the open threads, the successes, the goals' statuses, the median rounds and cost, and the reopenings, grouped by kind, suggested tier and model, status, the named worker, and the model that really ran. A success rate shows only for 10 threads or more, and R1 makes no finding. The check **R2** measures every routed thread end to end, by the arm it was assigned: whether the work was accepted (merged, not reopened, and not reverted within 14 days), the cost per accepted thread, the review rounds and hand fixes, and whether the worker that ran matched the assigned one.

## Limits

- It never picks a model for Pi, and it never asks a judge model to decide anything but the tier: the record is a suggestion.
- 1 call for each delegation, 3.5 s at most, and no retry.
- A failure is recorded as a route, never as an error to the person: the delegation goes on.

## Credit

Parts of `model-router.ts` are adapted from **pi-jev-model-router 0.9.0**, MIT License, Copyright (c) 2026 Shah Rukh. The full MIT notice is at the top of the file.

## Read more

The reference page is [Model router (shadow)](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/model-router.md), with [settings](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/model-router.md#settings), [what is sent](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/model-router.md#what-is-sent), [tiers](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/model-router.md#tiers), [features](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/model-router.md#features) and [the record](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/model-router.md#the-record).
