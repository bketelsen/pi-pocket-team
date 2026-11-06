# Model router (shadow)

A delegated night shift can get a **suggestion** of the model that would suit its brief. The router sends the brief to TypeSafe Jev, which judges the work, and it records the tier and the model it would pick. It is a record: nothing else changes. It needs Pi Pocket v0.22.0 or later for its settings. Like every new module, it starts off: Brian turns it on in **Menu → Extensions**. Without it, `team_delegate` works as before and records no route.

Brian's 3 rules, which the code keeps:

1. **Shadow mode only.** The router records its suggestion. It never changes a model, a worker, or a thinking level. The linked session still starts on the profile model, exactly as it does without the router.
2. **The brief goes to Jev masked.** Masking happens before the call: URLs, emails, IP addresses (IPv4 and IPv6), network host names, the host names in `~/.ssh/config`, and secret-like tokens (`ghp_`, `github_pat_`, `sk-`, `xox[bps]-`) become `[url]`, `[email]`, `[ip]`, `[host]` and `[secret]`. A dotted name is a host unless its last label is a file extension (any case; `api.example.sh`, with 2 dots, is a host too), and every literal `Host` alias is masked, a 1-letter one too. A suffix that is both a file extension and a top-level domain (`sh`, `so`, `md`, `py`, `rs`, `pub`) is ambiguous: such a name is masked (`example.sh`, and `install.sh` too) unless a `/` comes before it (`docs/x.md`, `./install.sh`) or its stem holds `_`. A repository name such as `bketelsen/pi-pocket` and a file name such as `team.ts` or `package.json` stay.
3. **Night shifts only, and a named worker still wins.** The router runs only when `team_delegate` has `night_shift`. When `night_shift.worker` names a model, that worker runs, exactly as before: the router is asked all the same (1 Jev call, the same masking), and the route carries the `worker`, so the audit can compare what the router would have picked with what the supervisor chose. The route changes no model, no `goal.worker` and no thinking level. An older router (API version 1) takes no worker: for it, `team.ts` still records an `explicit` route and asks Jev nothing. A delegation with no `night_shift` gets no route and no call.

## Settings

**Menu → Extensions → Model router**:

- **`mode`**: `off`, or `shadow` (the default). `shadow` classifies and records; `off` records the line `Route: off (the router's mode is off); nothing changes` and calls nothing.
- **`typesafeApiKey`**: the TypeSafe API key (a secret setting: the server sends it only to the fixed TypeSafe endpoint, as the `Authorization` header; see "What is sent"). It is also hidden from Pi's view with `host.hide`, so it shows as `[TYPESAFE_API_KEY]` in a tool result. Without a key, a route fails with "no TypeSafe key set", and the delegation goes on as before.

## What is sent

One POST to `https://api.typesafe.ai/v1/systemone` (fixed in the code: there is no environment override, because a variable could send the key elsewhere), with `Authorization: Bearer <key>`, the masked brief as `state.request`, the model alias `jev-latest`, and 4 questions. No folder, no history, no spend, and no environment. The timeout is 3.5 s in total, there is no retry, and a failure never holds a delegation: `team.ts` gives the router 4 s, then records a `failed` route and goes on.

## Tiers

`~/.config/pi-pocket-team/router.json` (optional, no secrets in it) sets the candidates. A missing file is fine; an invalid file gives the default tiers and a note on the route.

```json
{
    "tiers": {
        "quick": { "models": ["github-copilot/gpt-6-luna"], "thinking": "low" },
        "standard": { "models": ["deepseek/deepseek-flash"], "thinking": "medium" },
        "high": {
            "models": ["github-copilot/claude-sonnet-5.5", "github-copilot/gpt-6.1-sol"],
            "thinking": "medium"
        },
        "premium": { "models": ["github-copilot/claude-opus-5.5"], "thinking": "high" }
    }
}
```

A tier may be left out: it keeps its default. Only models the owner allows for subagents are usable, and a model with a problem now is skipped; then the nearer tiers are tried. DeepSeek is skipped in its peak hours (01:00 to 04:00 and 06:00 to 10:00 UTC). `plan` and `review` floor at `high`; `implement`, `debug`, `refactor`, `research` and `operate` floor at `standard`.

## The record

The route goes on the desk thread as `route` (stored data: never rename a field), with 1 event line:

```text
Route: implement (kind 0.82), complexity 1.8/3, demand 1.9 → high: github-copilot/claude-sonnet-5.5, thinking medium (no worker named; profile: github-copilot/claude-opus-5.5; shadow, not applied)
```

With a named worker, the route carries it in `worker`, and the line is shorter:

```text
Route: high: github-copilot/claude-sonnet-5.5 (implement 1.9); named deepseek/deepseek-flash runs; shadow
```

If the router fails beside a named worker, the line says `Route: failed, named <worker> runs (<reason>)`. The worker line is short on purpose (120 characters at most with model names of 32 characters), so the desk event holds all of it. A failure's reason comes last: the desk keeps the first 120 characters of an event, so a long reason loses only its end, never the worker (the route's `reason` field keeps all of it). A route is stored in a memo of the tool call, so a replayed delegation reads the first answer and Jev is never asked twice. The daily audit's check **R1** joins every route with what happened: the count, the open threads, the successes, the goals' statuses, the median rounds and cost, and the reopenings, grouped by kind, suggested tier and model, status, the named worker (`-` when none), and the model that really ran. A success rate shows only for 10 threads or more, and R1 makes no finding. R1 also has the metric `named`: for the shadow routes beside a named worker, how many routes there are, and for those where the router's model is the named worker (`same`) and the rest (`differs`), the count, the open threads, the successes, the failures, and how often the suggestion is also the model that ran (`suggestionRan`).

## Credit

Parts of `model-router.ts` (the 4 Jev questions, the task kinds, the kind floors, the demand formula, and `parseAnalysis`) are adapted from **pi-jev-model-router 0.9.0**, MIT License, Copyright (c) 2026 Shah Rukh. The full MIT notice is at the top of the file.
