# Model router (shadow)

Every delegation can get a **suggestion** of the model that would suit its brief. The router sends the brief to TypeSafe Jev, which judges the work, and it records the tier and the model it would pick, with the brief's **features** (facts known when the work starts). It is a record: nothing else changes. It needs Pi Pocket v0.22.0 or later for its settings. Like every new module, it starts off: Brian turns it on in **Menu → Extensions**. Without it, `team_delegate` works as before and records no route.

Brian's 3 rules, which the code keeps:

1. **Shadow mode only.** The router records its suggestion. It never changes a model, a worker, or a thinking level. The linked session still starts on the profile model, exactly as it does without the router.
2. **The brief goes to Jev masked.** Masking happens before the call: URLs, emails, IP addresses (IPv4 and IPv6), network host names, the host names in `~/.ssh/config`, and secret-like tokens (`ghp_`, `github_pat_`, `sk-`, `xox[bps]-`) become `[url]`, `[email]`, `[ip]`, `[host]` and `[secret]`. A dotted name is a host unless its last label is a file extension (any case; `api.example.sh`, with 2 dots, is a host too), and every literal `Host` alias is masked, a 1-letter one too. A suffix that is both a file extension and a top-level domain (`sh`, `so`, `md`, `py`, `rs`, `pub`) is ambiguous: such a name is masked (`example.sh`, and `install.sh` too) unless a `/` comes before it (`docs/x.md`, `./install.sh`) or its stem holds `_`. A repository name such as `bketelsen/pi-pocket` and a file name such as `team.ts` or `package.json` stay.
3. **Every delegation, and a named worker still wins.** The router runs on every `team_delegate` delegation, a night shift or not. 2 starts have none: a plan start, which starts a planning session, and a Clerk start, which opens no desk thread for the route to go on; neither is work a worker does. A night shift's brief is its objective and its stop condition; another delegation's brief is its task as the session gets it, with a plan task's brief before it. When `night_shift.worker` names a model, that worker runs, exactly as before: the router is asked all the same (1 Jev call, the same masking), and the route carries the `worker`, so the audit can compare what the router would have picked with what the supervisor chose. A delegation with no night shift has no worker, and its route has none. The route changes no model, no `goal.worker`, no thinking level and no tool result: a night shift's result names the route's line, as before, and another delegation's result does not. An older router (API version 1) takes no worker: for it, `team.ts` still records an `explicit` route and asks Jev nothing.

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

## Features

Every route that a router of API version 3 records carries `features`, version 1, and `briefHash`: off and failed routes too. `model-router.ts` exports `features(brief, repoDirs, analysis?, options?)`, a function with no network call that never throws:

```json
{
    "v": 1,
    "kind": "implement",
    "complexity": 1.8,
    "capability": 1.5,
    "deepReasoning": 0.4,
    "demand": 1.67,
    "briefChars": 412,
    "pathsNamed": 3,
    "reposNamed": 1,
    "language": "ts",
    "riskPathNamed": true,
    "testsBeside": true
}
```

- **`kind`, `complexity`, `capability`, `deepReasoning`, `demand`**: Jev's judgments at 2 decimals, and the demand the route gets (with the kind's floor). They are absent when Jev did not answer: mode `off`, no key, or a Jev failure.
- **`briefChars`**: the brief's length in characters (code points), before masking.
- **`pathsNamed`**: distinct tokens of the **masked** brief that hold a `/` or end in a known file extension. Quotes, brackets, sentence punctuation, a `:line`, a `#12` and a leading `./` come off first; a token of only `/` and `.` is none. A URL, a host or an IP address is masked first, so it is never a path. A roster repository (`owner/name`) holds a `/`: it counts here and in `reposNamed`.
- **`reposNamed`**: distinct `owner/name` tokens, in any case, that are repositories on the team roster (`options.roster`; with no roster, 0).
- **`language`**: from the first repository folder: `go.mod` → `go`; `tsconfig.json` → `ts`; `package.json` → `js`; `pyproject.toml` or `requirements.txt` → `python`; a folder with none → `other`; no folder, or one that does not exist → `unknown`.
- **`riskPathNamed`**: a named path matches a glob of a folder's `.github/risk-paths.json` (the matcher of `scripts/lib/risk-paths.mjs`, ported into the module; a test checks that both match the same paths). `null` when no folder has a readable list; `false` when a list is there and no named path matches.
- **`testsBeside`**: a named path's folder (the path itself when it is a folder) holds a `*_test.go`, `*.test.ts`, `*.test.mjs` or `test_*.py` file. `null` when no path is named or no folder exists.

The repository folder is the roster checkout of the delegation's repository; a delegation to a home or a workspace has none. Only paths inside a folder are read, each folder once: an absolute path outside it, or a `../` path, is never read, and every read goes by the resolved path, so a symbolic link to a place outside the folder (a named folder, `.github` or the list itself) is never followed. Every named path counts for `riskPathNamed` and `testsBeside`. The features keep counts and flags only, never brief text.

`briefHash` is the SHA-256 hex of the brief as it was given, not masked: it ties a route to its brief and keeps no text. When the router throws or takes more than 4 s, `team.ts` records the failed route itself, with the hash and the features of the router's `features` (API version 3), with no Jev field. A memo that an older `team.ts` wrote, with no features, replays as it is.

## The record

The route goes on the desk thread as `route` (stored data: never rename a field), with 1 event line:

```text
Route: implement (kind 0.82), complexity 1.8/3, demand 1.9 → high: github-copilot/claude-sonnet-5.5, thinking medium (no worker named; profile: github-copilot/claude-opus-5.5; shadow, not applied)
```

With a named worker, the route carries it in `worker`, and the line is shorter:

```text
Route: high: github-copilot/claude-sonnet-5.5 (implement 1.9); named deepseek/deepseek-flash runs; shadow
```

If the router fails beside a named worker, the line says `Route: failed, named <worker> runs (<reason>)`. The worker line is short on purpose (120 characters at most with model names of 32 characters), so the desk event holds all of it. A failure's reason comes last: the desk keeps the first 120 characters of an event, so a long reason loses only its end, never the worker (the route's `reason` field keeps all of it). A route is stored in a memo of the tool call, so a replayed delegation reads the first answer and Jev is never asked twice. The daily audit's check **R1** counts night shifts only: a route with a `briefHash` counts when its session has a night-shift goal, and an older route (no `briefHash`) was always a night shift's. It joins every such route with what happened: the count, the open threads, the successes, the goals' statuses, the median rounds and cost, and the reopenings, grouped by kind, suggested tier and model, status, the named worker (`-` when none), and the model that really ran. A success rate shows only for 10 threads or more, and R1 makes no finding. R1 also has the metric `named`: for the shadow routes beside a named worker, how many routes there are, and for those where the router's model is the named worker (`same`) and the rest (`differs`), the count, the open threads, the successes, the failures, and how often the suggestion is also the model that ran (`suggestionRan`).

## Credit

Parts of `model-router.ts` (the 4 Jev questions, the task kinds, the kind floors, the demand formula, and `parseAnalysis`) are adapted from **pi-jev-model-router 0.9.0**, MIT License, Copyright (c) 2026 Shah Rukh. The full MIT notice is at the top of the file.
