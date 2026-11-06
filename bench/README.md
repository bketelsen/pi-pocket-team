# Replay bench

The replay bench replays merged tasks on candidate models, each attempt in a `bwrap` sandbox, to measure cost, tokens, wall time and (in a later task) quality. The contract is the T1064 plan ("Route workers by measured task complexity"), sections "Bench", "Scoring" (the result schema) and "Cost and budget". Scoring (`bench/score.mjs`) and the harvester come in a later task.

Nothing here is a Pi Pocket module: `install.mjs` does not install it.

## Scripts

| Script                | What it does                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bench/run.mjs`       | 1 attempt of 1 model on 1 manifest task: budget reserve, slots, auth pre-flight, scratch clone, setup, then Pi in the sandbox. Writes 1 result file. Idempotent.      |
| `bench/batch.mjs`     | Every (task, model) pair of a manifest as `run.mjs` children, `--parallel` at a time. Holds the halogen lease when halogen is in the batch. Prints a table per model. |
| `bench/load-test.mjs` | Halogen only, under the lease: levels 1 to 4 of parallel attempts, then the halogen concurrency (highest level with no error and each attempt at 70% of level 1).     |
| `bench/report.mjs`    | A stage's summary per model: attempts, failures by kind, list cost, tokens, median and max wall time, and the total cost.                                             |
| `bench/budget.mjs`    | The budget guard: `set --budget <usd>`, `show`, `reap` (settles reservations of dead runners at their full cap).                                                      |
| `bench/pilot.json`    | The pilot manifest: 3 pi-pocket-team tasks (small, medium, large), picked by hand.                                                                                    |
| `bench/models.json`   | The 10 candidate models; `priced: false` for a model with no list price; `peakUtc` for DeepSeek's peak hours.                                                         |
| `bench/header-v1.md`  | The bench header: the first part of every prompt, and `/agent/AGENTS.md` in the sandbox.                                                                              |
| `bench/hosts`         | The sandbox's `/etc/hosts`: GitHub's hosts go to 127.0.0.1.                                                                                                           |

Examples:

```sh
node bench/budget.mjs set --budget 3000
node bench/run.mjs --manifest bench/pilot.json --task pilot-small --model github-copilot/gpt-6-luna --stage pilot --dry-run
node bench/batch.mjs --manifest bench/pilot.json --stage pilot --models all --tasks all
node bench/load-test.mjs --manifest bench/pilot.json --task pilot-small
node bench/report.mjs --stage pilot
```

## Exit codes of `run.mjs`

| Code | Meaning                                                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Attempt recorded (also a failed attempt, a limit, or a result that exists: then it prints `exists` and does nothing).                           |
| 1    | Usage error: a bad argument, an unknown task or model, a model not in `bench/models.json`, halogen without the lease, `bwrap` missing.          |
| 2    | Budget refused, or a DeepSeek attempt in DeepSeek's peak hours. Nothing is spent.                                                               |
| 3    | Harness failure after 3 tries (setup failed, auth pre-flight failed, or Pi ended before any assistant message). The result has `harness: true`. |

`--dry-run` validates everything and prints the bwrap argv and the budget state; it reserves, clones and starts nothing, and needs no `bwrap`, data dir or auth file.

## Sandbox

Each try runs `bwrap --unshare-pid --unshare-ipc --die-with-parent --new-session --clearenv`, in its own process group. The network stays open (model providers, the halogen endpoint, module registries).

| In the sandbox                                                           | From the host                                                                 | Mode       |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------- |
| `/work`                                                                  | the try's scratch clone (at the parent; no ref, tag, remote, reflog or merge) | read-write |
| `/session`                                                               | the try's `session/` folder                                                   | read-write |
| `/agent`                                                                 | `<data>/agent/`, shared by all tries                                          | read-write |
| `/agent/AGENTS.md`                                                       | `bench/header-v1.md`                                                          | read-only  |
| `/agent/settings.json`                                                   | `<data>/agent-files/settings.json` (`{}`)                                     | read-only  |
| `/agent/models.json`                                                     | `~/.pi/agent/models.json` (`--agent-src`)                                     | read-only  |
| `/agent/auth.json`                                                       | `~/.pi/agent/auth.json` (`--agent-src`)                                       | read-write |
| `/pocket`                                                                | the Pi Pocket checkout (`--pocket`)                                           | read-only  |
| `/usr`, `/etc/ssl`, `/etc/pki`, `/etc/nsswitch.conf`, `/etc/resolv.conf` | the host (`/bin`, `/lib` and the like are symlinks into `/usr`)               | read-only  |
| `/etc/hosts`                                                             | `bench/hosts`                                                                 | read-only  |
| `/tools`                                                                 | `~/.local/share/mise/installs` (`--mise-installs`)                            | read-only  |
| `/cache`                                                                 | the try's `cache/` (`go`, `npm`, `pip`)                                       | read-write |
| `/tmp`, `/home/bench`                                                    | tmpfs                                                                         | read-write |

Environment: `PI_CODING_AGENT_DIR=/agent`, `HOME=/home/bench`, `PATH` (node, then the newest Go and Python under `/tools`, then `/usr/bin:/bin`), `GOMODCACHE`, `npm_config_cache`, `PIP_CACHE_DIR`, `BENCH_TRY`. bwrap adds `PWD`. Nothing else: no `GH_TOKEN`, no `SSH_AUTH_SOCK`.

Before each try of an OAuth provider, the runner refreshes the token on the host (`pi auth print-bearer-token --min-expiry 60m`, output ignored), so the sandbox needs no refresh. It reads only the `type` field of the auth file.

## Limits and retries

- Per attempt: 45 minutes of Pi wall time; $8 of list cost for a priced model, 4,000,000 tokens for an unpriced one. The limits count over all tries of the attempt. At a limit: SIGTERM to the process group, SIGKILL after 10 s, `failure: "limit"`.
- A provider error (`stopReason: "error"` on the last assistant message): 1 retry on a fresh clone; then `failure: "provider"`.
- A harness failure: 2 repeats on a fresh clone, then `harness: true` and exit 3.
- A stream with no final event, or with an assistant message that did not end: `usage.partial: true`.
- `wallMs` in a result is the sum of the tries' Pi wall time (not clone or setup time).

## Data

The data dir is `$BENCH_DATA`, else `~/.local/share/pi-pocket-team/bench` (folders 0700, files 0600). It holds `spend.json` (the budget), `slots/`, `halogen.json`, `agent/`, `agent-files/` and `runs/<stage>/<task>/<model-slug>[--<run-id>]/try-<n>/` with `work/`, `session/`, `cache/`, `events.jsonl` and `stderr.log`. Run folders are kept; a new run of the same attempt continues the try numbers. Result files go to `bench/results/` (ignored by git) or `--results`.

Concurrency: at most 4 tries on the host and 2 per provider; halogen at most the `concurrency` of `halogen.json` (1 before the load test). Halogen needs the lease: `~/.pi/agent/bin/lease take halogen T1064 "bench"` (`batch.mjs` and `load-test.mjs` take it themselves).

## Tests

`bench/*.test.mjs` use a fake `pi` (`bench/fixtures/fake-pi.cjs`), temp data and lease dirs, and a fixture git repository. Most run behind a fake `bwrap` (`bench/fixtures/fake-bwrap.mjs`, no isolation); `bench/sandbox.test.mjs` uses the real `bwrap` and skips where it cannot run. No test calls a model.
