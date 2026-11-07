# Shift

"Do X while I am away. Stop only when Y." Pi works in rounds; after each round's answer the module decides whether to go on. A shift runs at any hour, not only at night. The command is `/team-shift`; its old name `/night-shift` still works (see [Old names](#old-names)).

## Commands

```text
/team-shift [start 06:00] [until 07:00 | for 8h] [max 30] [with provider/model] [check `npm test`]: <objective>; stop when <condition>
/team-shift status | stop | resume
```

- Options come first, in any order, then an optional `:`, then the objective. The text splits at the last "stop when" (or "stop only when").
- `start 06:00` (also `6am`): round 1 waits until the next time the server's clock (America/New_York) shows it. At most 24 hours away. Without it, round 1 starts at once.
- `until 07:00` (also `7am`, `11:45pm`) is the next time the server's clock shows it, so at most 24 hours away. `for 8h`, `for 90m`, `for 7h30m`: from `start` when it is given, else from now, up to 24 hours. Give one or neither; `until` must be after `start`.
- `max N`: rounds, 1 to 100. Default 20.
- `with provider/model`: runs the work in subagents on that model, for example `github-copilot/claude-sonnet-5.5`. The model must be in **Providers → Models for subagents**; the command refuses another model, and it never substitutes one. With a `deepseek/…` worker and no `start`, round 1 waits for the end of DeepSeek's peak hours. The status, the set card, and the summary say which worker ran.
- `` check `cmd` ``: runs in the session's folder after Pi says DONE; it must pass too. Owner only (see Lancet Guard below).
- `status` shows the goal and its last rounds as a card. `stop` ends it after the round that runs (Stop ends that round now). `resume` goes on with a paused or stopped goal while rounds and time are left.

Examples:

```text
/team-shift until 07:00 max 30: migrate the API client to v2; stop when all tests pass and the PR is open
/team-shift start 06:00 until 17:00 max 40: <objective>; stop when <condition>
/team-shift with github-copilot/claude-sonnet-5.5 until 07:00 max 25: migrate the API client; stop when all tests pass
/team-shift for 6h check `npm test`: fix the flaky login tests; stop only when the suite passes 3 times in a row
```

## A start time

`start 06:00` holds round 1 until the next 06:00 on the server's clock, so a goal set before bed can begin after the DeepSeek Flash peak hours (01:00–04:00 and 06:00–10:00 UTC). The start must be within 24 hours; `until` must be after it; `for` and the 24-hour limit count from it. The status line says "waiting until 06:00 EDT", and `/team-shift stop` cancels it.

With `with deepseek/…` and no `start`, a goal set during DeepSeek's peak hours (01:00–04:00 and 06:00–10:00 UTC) waits until that window ends: 04:00 UTC or 10:00 UTC on the same day. Outside those hours, round 1 starts at once. The label shows the server's clock, such as "05:00 EST". `for` counts from that start, `until` must be after it, and the status says "waiting until 05:00 EST (after DeepSeek's peak hours …)". An explicit `start` always wins.

A person's message during the wait does not cancel the goal: messages written then do not pause it at start. Plan mode at start pauses it, as before a round. The prompt section is off before round 1, because a person can talk to Pi during the wait. The wait is a restart-safe wait in the driver task's `wait` phase, so a restart neither starts round 1 early nor twice, and a server that was down past the start time starts round 1 at once.

## How a round goes

1. The module sends a message, `[shift] Round N of M…`, with the objective, the stop condition, the deadline, and what happened last round (Pi's reason, or the check's failing output).
2. A prompt section (its id is `night-shift`, from round 1 while a goal runs) tells Pi to end every answer with `STATUS: DONE|CONTINUE|BLOCKED: <reason>`, to say DONE only when the condition holds, to say BLOCKED when only a person can help, and never to work around Lancet Guard or plan mode.
3. Pi's answer decides: DONE ends the goal (after the check passes, when there is one); BLOCKED ends it; CONTINUE, or no status line, goes on. Pi judges the condition itself: no other model is asked, and the module never picks a model.

## When it stops

| Stops when                                      | Then                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| Pi says DONE (and the check passes)             | ended; Pi writes the summary for the morning                          |
| all rounds used                                 | ended; summary                                                        |
| the deadline passed (checked before each round) | ended; summary                                                        |
| Pi says BLOCKED                                 | ended; summary                                                        |
| the same check failure comes 3 times in a row   | ended as blocked; summary                                             |
| a person writes in the session                  | **paused**, with a notice; no summary (the person is there); `resume` |
| plan mode is on                                 | paused; `resume` after plan mode is off                               |
| Stop, or `/team-shift stop`                     | ended; no summary                                                     |
| a spend limit (Pocket's `heldBack`)             | ended; no summary (Pi may not start)                                  |
| a round gets no answer (a model error)          | ended, with the error                                                 |

The same check failure 3 times in a row ends the goal as `blocked`, with the summary. The streak stays in the goal, outside the newest 30 round records. A fingerprint is the sorted failing `gh pr checks` names, or normalized output for a label failure or another check. A label failure after passing rows counts; only pending rows do not count. A cut-off check does not change the streak, and a pass or check with no fingerprint resets it. The stop records the failing jobs of the last check in the goal's `stopChecks`: each failing or cancelled `gh pr checks` row, with its name and, from its URL, its repository, run and job id (at most 20). A check with no gh rows records none, and resume removes them.

The summary is one more message after the last round: what Pi did, what is left, and why it stopped. A round that runs at the deadline finishes; no round starts after it. A person's message is any `pi.user` message that is not one of the module's own (`[shift]`, or `[night-shift]` in older entries) and not known as automated (`[via …]` from linked sessions, PiP, webhooks and watches; `[scheduled]`; subagent reports; Done when's `[goal]`): when unsure, it pauses.

The status line under the message box shows the goal (`Shift 3/30 · until 07:00 EDT`, `Shift waiting until 06:00 EDT`, paused, or how it ended, for 12 hours); tap it for the rounds.

## Durability

Pocket's own "Done when" (`src/server/goals.ts`) drives its rounds from an `onYield` hook. A drop-in's hook can read and keep memos but cannot commit, and a command cannot start Pi, so this module drives its rounds from a durable task, `x.night-shift.driver`, as Pocket's schedules and subagent reporters do. Each step is a checkpoint:

- A round's message has a request id made of the goal, the round, and the attempt (`p:<person>:x-night-shift-<goal>-<round>-<attempt>`), so a restart that sends it again finds the first: one answer never starts two rounds.
- The round count goes up in the same commit that moves the task on to send that round.
- A `start` time is a restart-safe wait in the task's `wait` phase, before round 1: a restart sleeps again until the stored start, and a server that was down past it starts round 1 at once. Round 1 starts only in `decide`, which moves the round count in its commit: never twice.
- The check is behind two memos, as in goals.ts: one set before it runs, one with its result. A restart that finds the first without the second does not run it again; the next round tells Pi it was cut off.
- The `p:<person>:` request id is how Pocket marks a message it sends for a person: Pi works for whoever set the goal, and the spend is theirs.
- A run before a round that fails would leave the round queued for ever: the module takes it back and sends it again, 3 times at most.

State is one document per conversation, `x.night-shift.goal` (`{ goal?: Goal }`; a fork starts without it). It is stored data: never rename the kind or the task, or change what a field means.

## Limits and rules

- **Lancet Guard:** every tool call of every round goes through the guard as usual. If the guard asks a person, the round waits for that person; the deadline does not cut it short. A free check command runs unasked, with the owner's rights, and the guard does not see it (a drop-in cannot ask the guard): like the owner's own `!` commands. So only the owner can set or resume a goal with a free check, with `/team-shift` in the session.
- **The 1 exception: `pr_check`.** A delegated shift can take `shift.pr_check`, and only that. It is safe: the program is always `gh`, the calls are read only (`gh pr checks`, and `gh pr view --json labels`), every value is checked before it is used, and the module writes the command itself. No model chooses the shell. A free check command stays owner-only.
- **Plan mode:** a goal does not start in plan mode, and pauses before a round when plan mode is on. Reading plan mode uses Pocket's own `pocket.plan` document, which is not public API: if it changes, the read fails and the goal relies on Pi saying BLOCKED, as the prompt asks.
- **Worker:** the model must be in the owner's allowed list for subagents. The command and `team_delegate` refuse another model; `resume` checks the list again, because it can change. No other model is ever used in its place.
- **Who:** anyone who can steer the session runs `/team-shift`; a check needs the owner. One goal per session. Any session works, linked sessions included.
- Objective and condition together: 3000 characters. Check: 2000 characters, 10 minutes, the last 3000 characters of its output.

## Delegated shifts

A supervisor identity (Odrade) can start a shift in the linked session that `team_delegate` makes, with its `shift` argument (`night_shift` is its old name, with the same fields; a call that gives both is refused with `Give shift or night_shift, not both.`, before anything starts). It works for the person behind Odrade's session (Brian), and the goal's spend is his. The goal is set in one commit with the specialist's identity, so a restart leaves either both or neither.

- **No free check, but `pr_check`.** A free check command runs unasked with the owner's rights, and Lancet Guard does not see it, so only the owner sets one, with `/team-shift` in the session. `team_delegate` refuses a `shift` that has `check`. It takes `pr_check` instead: `{ pr?, repo?, checks?, label? }`. `checks` is `required` (the default), `all`, or `none` with a label; `none` with no label is refused. The module builds `gh pr checks` and `gh pr view`, read only, and `&&` joins them: every part must pass. `pr` may be left out only when the delegation made a worktree of its own, because then the current branch is the task's branch. `repo` needs `pr`: with `--repo`, `gh` does not read the current branch. `repo`, `pr` and `label` are checked, so a value that holds shell characters is refused. `required` runs `gh pr checks --required`. When the repository has no required check (`gh` exits 1 and its stderr is the line `no required checks reported on the '<branch>' branch`; check rows on stdout never count), it falls back to `gh pr checks`, all checks. A pass prints `pr_check: the required checks pass.` or `pr_check: the repository requires no checks, and all checks pass.`; the status card and the stop reason show that line. A failing or pending required check still fails, with `gh`'s exit code (1 or 8), and the fallback does not run. A failing or pending check in the fallback fails the same way.
- **The first message is the message before round 1.** It says that round 1 comes as a separate `[shift]` message, to answer it with one short line, and not to send a report with `team_message`.
- **The report comes back by itself.** When the goal stops, the driver sends one report to Odrade's session (it starts `Shift report from this linked session:`), with the reason and Pi's summary answer (in ASD-STE100). With a worker, the report adds `Rounds: N, worker: <worker>.`, so rounds can be counted per provider. A restart reruns the report phase, and its key makes the send happen once. `/team-shift stop` sends the same kind of report, best effort. A delegated goal's summary prompt asks Pi to end with an `ASKS FOR BRIAN:` line and 1 line for each decision Brian must make (with `[a | b]` options for a pick-one, or `none`). The shift module reads that block with the desk's own parser (`asks` on the desk's API, `reportAsksOf` in `desk.ts`), so the 2 modules cannot drift, and passes 1 to 4 asks to the desk, so each becomes an ask on the thread in the report's commit; more than 4, or none, leaves the decisions in the text. The items it files are the items that hold a thread (`decisionItem`), as written, and an item that ends with `[a | b]` keeps its options. It does not import `desk.ts`: the desk's API comes from the global, as `team.ts` finds the shift module. An older desk with no `asks` gives none: the text alone holds the thread then.
- **Two modules, no import.** `team.ts` finds the shift module through `globalThis[Symbol.for("pi-pocket-team.night-shift")]`. An import would keep a stale copy after a reload. Both modules must be on in **Menu → Extensions**; without `night-shift.ts` the tool says so. The desk's goal board reads `zone`, `nextClockTime` and `localMidnight` from the same global API for its times (see [Desk](desk.md)); an older shift module has neither clock member, and the board then refuses a pick.
- **The worker.** `shift.worker` goes through the same allowed-list rule as `/team-shift with`, and the tool refuses a model outside the list before it starts the linked session.
- **Replay.** The goal's id comes from the tool call's key, so the same call run again finds its goal and its driver: one goal, one driver.

## Shift files

`night-shift.ts` (server: command, prompt section, driver task, one route), `night-shift-web/index.js` (the status-line item and its sheet; route `GET /api/x/night-shift/goal/:conversation`, for people who see every session). A new module starts off: the owner turns it on in **Menu → Extensions**.

## Caveats

- Shift reads 2 Pi Pocket internals that are not public API, so a Pocket upgrade can break it:
    - the `pocket.plan` document, to see plan mode. If it changes, the read fails safe: the goal relies on Pi to answer BLOCKED in plan mode, as its prompt section asks, and BLOCKED ends the goal.
    - the request-id format `p:<person>:…`, which marks a message that Pocket sends for a person (`src/server/requests.ts`). If it changes, Pocket can refuse a round or count its spend differently. A round with no answer ends the goal with the error; it does not run on.
- The modules are tested against the Pocket version in Requirements only. Team and Homewiki are owner-oriented and tuned to one person's server.

## Old names

The feature was called "night shift". It runs at any hour, so the texts that people and models read now say "shift". 2 old names stay as aliases:

- **`/night-shift`** runs the same handler as `/team-shift`, with the same subcommands and options. Each answer (a card, a notice, or a refusal made with `web.error`) starts with the line "`/night-shift` is now `/team-shift`."
- **`night_shift`** in `team_delegate` takes the same fields as `shift`. A call that gives both is refused with `Give shift or night_shift, not both.`

The command is `/team-shift`, not `/shift`, because Pi Pocket requires a `-` in an extension command name (`COMMAND_NAME` in Pi Pocket's `src/server/extension-web.ts`), so a new built-in command never takes a module's name.

These names keep "night-shift", because they are stored data or live identity:

- The file `night-shift.ts`, the folder `night-shift-web/`, and the module name `night-shift`. A new module name is a new module in Pi Pocket: it must be turned on again in **Menu → Extensions**, and a running goal's driver would lose its module. The route stays `GET /api/x/night-shift/goal/:conversation`.
- The global symbol `Symbol.for("pi-pocket-team.night-shift")`, which Team and the desk read.
- The document kind `x.night-shift.goal`, the task name `x.night-shift.driver`, the round request ids `p:<person>:x-night-shift-…`, and the report keys `x.night-shift.report:…`.
- The prompt section id `night-shift`, and the report value `from: "night-shift"` that the desk files and compares.
- The desk's archive skip reasons `night-shift` and `night-shift-unknown`, which are stored on threads. The desk shows them as `shift` and `shift-unknown`.

Old entries start with `[night-shift]`. The readers of the round prefix (`personOf` here, the desk's "desk ok" reader, and the daily audit's E3 check) accept `[shift]` and `[night-shift]`.
