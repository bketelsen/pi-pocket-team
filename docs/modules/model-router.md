# Model router (shadow)

Every delegation can get a **suggestion** of the model that would suit its brief. The router sends the brief to TypeSafe Jev, which judges the work, and it records the tier and the model it would pick, with the brief's **features** (facts known when the work starts). In the default mode `shadow` it is a record: nothing else changes. Router v3 of plan T1064 (the module's API version 4) adds **rule v1**: an eligible shift gets the band of the bench's frozen rule, and in mode `assign`, on a band Brian made live, a worker (see [Rule v1 and assign mode](#rule-v1-and-assign-mode)). It needs Pi Pocket v0.22.0 or later for its settings. Like every new module, it starts off: Brian turns it on in **Menu → Extensions**. Without it, `team_delegate` works as before and records no route.

Brian's 3 rules, which the code keeps:

1. **Shadow unless Brian says so.** In mode `shadow` (the default) the router records its suggestion, and changes no model, no worker and no thinking level. Only in mode `assign`, on a band in `liveTiers` (both set by Brian), an eligible shift gets an assigned worker and its thinking level (plan T1064, section Rollout). The linked session always starts on the profile model, exactly as it does without the router: no mode changes it.
2. **The brief goes to Jev masked.** Masking happens before the call: URLs, emails, IP addresses (IPv4 and IPv6), network host names, the host names in `~/.ssh/config`, and secret-like tokens (`ghp_`, `github_pat_`, `sk-`, `xox[bps]-`) become `[url]`, `[email]`, `[ip]`, `[host]` and `[secret]`. A dotted name is a host unless its last label is a file extension (any case; `api.example.sh`, with 2 dots, is a host too), and every literal `Host` alias is masked, a 1-letter one too. A suffix that is both a file extension and a top-level domain (`sh`, `so`, `md`, `py`, `rs`, `pub`) is ambiguous: such a name is masked (`example.sh`, and `install.sh` too) unless a `/` comes before it (`docs/x.md`, `./install.sh`) or its stem holds `_`. A repository name such as `bketelsen/pi-pocket` and a file name such as `team.ts` or `package.json` stay.
3. **Every delegation, and a named worker still wins.** The router runs on every `team_delegate` delegation, a shift or not. 2 starts have none: a plan start, which starts a planning session, and a Clerk start, which opens no desk thread for the route to go on; neither is work a worker does. A shift's brief is its objective and its stop condition; another delegation's brief is its task as the session gets it, with a plan task's brief before it. When `shift.worker` names a model, that worker runs, exactly as before: the router is asked all the same (1 Jev call, the same masking), and the route carries the `worker`, so the audit can compare what the router would have picked with what the supervisor chose. A delegation with no shift has no worker, and its route has none. Outside an assignment, the route changes no model, no `goal.worker`, no thinking level and no tool result: a shift's result names the route's line, as before, and another delegation's result does not. A named worker is never eligible, so it always wins over an assignment. An older router (API version 1) takes no worker: for it, `team.ts` still records an `explicit` route and asks Jev nothing.

## Settings

**Menu → Extensions → Model router**:

- **`mode`**: `off`, `shadow` (the default), or `assign`. `shadow` classifies and records; `off` records the line `Route: off (the router's mode is off); nothing changes` and calls nothing. `assign` classifies and records as `shadow` does, and assigns a worker only to an eligible shift whose band is in `liveTiers` and has a pick.
- **`liveTiers`**: a comma list of the bands of rule v1 (`easy`, `medium`, `hard`) that are live in mode `assign`. The default is empty: no band is live. An unknown name is ignored, with a note on each eligible route (`liveTiers: a name that is not a band is ignored`); the note never repeats the value.
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
- **`riskPathNamed`**: a named path matches an L1 or L2 glob of a folder's `.github/risk-paths.json`, or any glob of a version 1 list (the matcher of `scripts/lib/risk-paths.mjs`, ported into the module; a test checks that both match the same paths). `null` when no folder has a readable list; `false` when a list is there and no named path matches. The flag means "a named path is a risk path", a path that gets `risk:high`: the L3 and L4 globs of a version 2 list ([frostyard/core ADR-0078](https://github.com/frostyard/core/blob/main/docs/adr/0078-sort-pull-requests-by-levels-l1-to-l4.md)) are not risk paths, so they never set it.
- **`testsBeside`**: a named path's folder (the path itself when it is a folder) holds a `*_test.go`, `*.test.ts`, `*.test.mjs` or `test_*.py` file. `null` when no path is named or no folder exists.

The repository folder is the roster checkout of the delegation's repository; a delegation to a home or a workspace has none. Only paths inside a folder are read, each folder once: an absolute path outside it, or a `../` path, is never read, and every read goes by the resolved path, so a symbolic link to a place outside the folder (a named folder, `.github` or the list itself) is never followed. Every named path counts for `riskPathNamed` and `testsBeside`. The features keep counts and flags only, never brief text.

`briefHash` is the SHA-256 hex of the brief as it was given, not masked: it ties a route to its brief and keeps no text. When the router throws or takes more than 4 s, `team.ts` records the failed route itself, with the hash and the features of the router's `features` (API version 3), with no Jev field. A memo that an older `team.ts` wrote, with no features, replays as it is.

## Rule v1 and assign mode

The bench (plan T1064, [router-bench.md](../plans/router-bench.md)) measured worker models on replayed tasks, and froze a rule that predicts a task's band from facts known at delegation time: `bench/rule-v1.json`. The module reads a copy of it, `router-rule-v1.json` beside `model-router.ts`, which `install.mjs` installs with the module (`PI_POCKET_TEAM_ROUTER_RULE` names another file, for the tests). `model-router.test.ts` checks that the copy holds the same rule, and that `predictBand`, the module's port of the bench's `predictTier`, gives the same band.

**Eligible.** A route is eligible when all of these hold (the bench's population, plan T1064, section Method): the delegation is a shift (`team.ts` says so with `shift: true`); it names no worker; Jev answered with the kind `implement`, `debug`, `refactor` or `write`; its repository is a bench repository (`BENCH_REPOS`, the same list as the audit's `R2_BENCH_REPOS`); every roster repository that the brief names is a bench repository; and the features say that no risk path is named (`riskPathNamed: false`; `null`, no list to read, is not eligible). A route that is not eligible is recorded as before, with the 4 tiers and the kind floors.

**Band.** An eligible route records `tierRule: "v1"` and the band in `tier` (`easy`, `medium` or `hard`), from the features with Jev's judgments. The kind floors do not apply to it. An absent or invalid rule file gives no band and no assignment: the route keeps the 4 tiers, and a note says why (`the rule file router-rule-v1.json is absent: no band, no assignment`).

**Picks.** `RULE_PICKS` in `model-router.ts` is the bench's decision table, per band `{ model, thinking, control }`. It ships **empty**: on 2026-11-10 stage 2's branch was `wait` (R = 22, under 30), so no band has a pick, and no route gets an assignment. The control of a band (the worker Odrade named most often on that band's eligible lines in the 30 days before stage 2 decides) is counted only when a pick is decided, so it is unset too. A later round fills the table in the code, or Brian fills it in `router.json`:

```json
{
    "ruleV1": {
        "experiment": "T1064-easy-1",
        "picks": {
            "easy": {
                "model": "github-copilot/gpt-6-luna",
                "thinking": "high",
                "control": "deepseek/deepseek-flash"
            }
        }
    }
}
```

An entry of `ruleV1.picks` replaces the code's pick of its band. An invalid entry (a model or control that is not `provider/model`, a thinking level Pi does not know) or an unknown band is ignored with a note that never repeats the value; so are an invalid `experiment` and a `ruleV1` that is not an object. Before a route is given back, the key is taken out of every string in it, in any case (`[TYPESAFE_API_KEY]`): the key read when the route started, and the key the settings hold when it ends, so a key changed while Jev answers is taken out too. A key pasted into `liveTiers` or `router.json` by mistake never reaches the memo or the desk. A file with only `ruleV1` keeps the default tiers. With a pick, a `shadow` route records the pick as its suggestion (`model`, `thinking`); with none, it records no model.

**Assign.** In mode `assign`, on an eligible shift of a band in `liveTiers` with a pick, the arm comes from the desk thread's id: `A` when the first byte of SHA-256(thread id) is even, else `B`. Arm A gets the pick at its thinking level (the tested configuration); arm B gets the control, with no thinking level, as Odrade names a worker today. A model that is not in the owner's allowed list for subagents, has a problem now (`host.modelProblem`), or is a `deepseek/…` model at a start in DeepSeek's peak hours cannot be used: arm A falls back to the control, then to no assignment; arm B to no assignment. Each step leaves a note. The route records `arm`, `assigned`, `assignedThinking` (arm A only), and `experiment` when one is named; its status is `assigned`. With no usable model it keeps the arm, status `shadow` and the reason `assign: no usable model`. With no desk thread (the desk is off, or a shift module older than version 4) there is no arm and no assignment. `team.ts` checks the shift module's version again where it applies a route, so an `assigned` route from a memo that an older shift module meets after a reload applies nothing.

**How the worker runs.** `team.ts` puts an `assigned` route's worker in the shift's `worker`, and its thinking level in the goal's `workerThinking` (shift module version 4), before the linked session starts; it checks the allowed list again first. The round's prompt names both: `give execution to subagents on <model> and thinking <level>`. A named worker always wins; the profile model never changes. The route is in the tool call's memo, so a replay gets the same arm and worker. The audit's R2 counts a spawn on another model or thinking level as a deviation.

## The record

The route goes on the desk thread as `route` (stored data: never rename a field), with 1 event line:

```text
Route: implement (kind 0.82), complexity 1.8/3, demand 1.9 → high: github-copilot/claude-sonnet-5.5, thinking medium (no worker named; profile: github-copilot/claude-opus-5.5; shadow, not applied)
```

An eligible route (rule v1) says its band, and what it picked or assigned:

```text
Route: v1 easy: no pick (implement 2.0); today's policy; shadow
Route: v1 easy: github-copilot/gpt-6-luna, thinking high (implement 2.0); shadow, not applied
Route: v1 easy: arm A assigned github-copilot/gpt-6-luna, thinking high (implement 2.0); assign
Route: v1 easy: arm B assigned deepseek/deepseek-flash (implement 2.0); assign
```

With a named worker, the route carries it in `worker`, and the line is shorter:

```text
Route: high: github-copilot/claude-sonnet-5.5 (implement 1.9); named deepseek/deepseek-flash runs; shadow
```

If the router fails beside a named worker, the line says `Route: failed, named <worker> runs (<reason>)`. The worker line is short on purpose (120 characters at most with model names of 32 characters), so the desk event holds all of it. A failure's reason comes last: the desk keeps the first 120 characters of an event, so a long reason loses only its end, never the worker (the route's `reason` field keeps all of it). A route is stored in a memo of the tool call, so a replayed delegation reads the first answer and Jev is never asked twice. The daily audit's check **R1** counts shifts only: a route with a `briefHash` counts when its session has a shift goal, and an older route (no `briefHash`) was always a shift's. It joins every such route with what happened: the count, the open threads, the successes, the goals' statuses, the median rounds and cost, and the reopenings, grouped by kind, suggested tier and model, status, the named worker (`-` when none), and the model that really ran. A success rate shows only for 10 threads or more, and R1 makes no finding. R1 also has the metric `named`: for the shadow routes beside a named worker, how many routes there are, and for those where the router's model is the named worker (`same`) and the rest (`differs`), the count, the open threads, the successes, the failures, and how often the suggestion is also the model that ran (`suggestionRan`). The check **R2** measures every routed thread end to end, by the arm it was assigned (intent to treat): whether the work was accepted (merged, not reopened for rework, and not reverted within 14 days; the rules are on the [daily audit page](daily-audit.md)), its cost per accepted thread, its review rounds and parent hand fixes, and whether the worker that ran matched the assigned one. It also gives the share of shifts a routed worker could take.

## Credit

Parts of `model-router.ts` (the 4 Jev questions, the task kinds, the kind floors, the demand formula, and `parseAnalysis`) are adapted from **pi-jev-model-router 0.9.0**, MIT License, Copyright (c) 2026 Shah Rukh. The full MIT notice is at the top of the file.
