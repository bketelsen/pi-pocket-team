# Shift

"Do X while I am away. Stop only when Y." Pi works in rounds, at any hour; after each round's answer the module decides whether to go on. When the goal stops, Pi writes a summary: what it did, what is left, and why it stopped.

Files: `night-shift.ts` (the command, the prompt section, the driver task and 1 route) and `night-shift-web/` (the status-line item and its sheet). There is no page: you type `/team-shift` in a conversation, and the status-line item under the message box opens the rounds.

## Use it

```text
/team-shift [start 06:00] [until 07:00 | for 8h] [max 30] [with provider/model] [check `npm test`]: <objective>; stop when <condition>
/team-shift status | stop | resume
```

- Options come first, in any order, then an optional `:`, then the objective. The text splits at the last "stop when" (or "stop only when").
- `start 06:00` (also `6am`): round 1 waits until the next time the server's clock shows it, at most 24 hours away. Without it, round 1 starts at once, with 1 exception: with a `deepseek/…` worker, a goal set during DeepSeek's peak hours (01:00–04:00 and 06:00–10:00 UTC) waits until that window ends, at 04:00 or 10:00 UTC; outside them it starts at once. An explicit `start` always wins.
- `until 07:00` is the next time the server's clock shows it. `for 8h`, `for 90m`, `for 7h30m` count from the start of round 1 (a given `start`, or the DeepSeek wait), else from now, up to 24 hours. Give one or neither, and `until` must be after `start`.
- `max N`: rounds, 1 to 100. Default 20.
- `with provider/model`: runs the work in subagents on that model. The model must be in **Providers → Models for subagents**; the command refuses another model, and it never substitutes one.
- `` check `cmd` ``: runs in the session's folder after Pi says DONE, and it must pass too. Owner only.
- `status` shows the goal and its last rounds as a card. `stop` ends it after the round that runs. `resume` goes on with a paused or stopped goal while rounds and time are left.

Examples:

```text
/team-shift until 07:00 max 30: migrate the API client to v2; stop when all tests pass and the PR is open
/team-shift start 06:00 until 17:00 max 40: <objective>; stop when <condition>
/team-shift for 6h check `npm test`: fix the flaky login tests; stop only when the suite passes 3 times in a row
```

## How a round goes

1. The module sends a message, `[shift] Round N of M…`, with the objective, the stop condition, the deadline, and what happened last round.
2. A prompt section tells Pi to end every answer with `STATUS: DONE|CONTINUE|BLOCKED: <reason>`, to say DONE only when the condition holds, and never to work around Lancet Guard or plan mode.
3. Pi's answer decides: DONE ends the goal (after the check passes, when there is one); BLOCKED ends it; CONTINUE, or no status line, goes on. Pi judges the condition itself: no other model is asked.
4. After round 1, a round waits while Pi works, while its subagents work, or while a background command that will tell Pi it ended still runs: at most 60 minutes, then it goes anyway. A PR watch does not hold it. A person's message, plan mode and the other stops still apply during the wait.

## When it stops

| Stops when                                    | Then                                         |
| --------------------------------------------- | -------------------------------------------- |
| Pi says DONE (and the check passes)           | ended; Pi writes the summary for the morning |
| all rounds used                               | ended; summary                               |
| the deadline passed                           | ended; summary                               |
| Pi says BLOCKED                               | ended; summary                               |
| the same check failure comes 3 times in a row | ended as blocked; summary                    |
| a person writes in the session                | paused, with a notice; `resume`              |
| plan mode is on                               | paused; `resume` after plan mode is off      |
| Stop, or `/team-shift stop`                   | ended; no summary                            |
| a spend limit                                 | ended; no summary                            |
| a round gets no answer (a model error)        | ended, with the error                        |

The status line under the message box shows the goal, for example `Shift 3/30 · until 07:00 EDT`, or that it waits, is paused, or how it ended. Tap it for the rounds.

## Durability

The rounds come from a durable task, `x.night-shift.driver`, and each step is a checkpoint: a round's message has a request id, so a restart never starts 2 rounds from 1 answer; the round count moves in the commit that sends the round; and the check is behind 2 memos, so a restart does not run it again. A `start` time is a restart-safe wait before round 1, so a server that was down past the start time starts round 1 at once and never twice.

State is one document per conversation, `x.night-shift.goal`. It is stored data.

## Delegated shifts

A supervisor identity can start a shift in the linked session that `team_delegate` makes, with its `shift` argument: `{ objective?, stop_when, start?, until?, for?, max?, worker?, pr_check? }`. The report comes back to the supervisor's session by itself when the goal stops. Each round also gives the supervisor's address, from the linked session's first message, so Pi can ask a question before then with `team_message`. Its summary also writes 1 line `PRS:` with each PR the shift touched, as `owner/name#N`, or `PRS: none`: the desk puts each PR on the thread. `night_shift` is the old name of `shift`, with the same fields; a call that gives both is refused.

A shift from the tool takes no free check command. `pr_check` is the only check it takes: a structured PR check, and the module builds the `gh` command itself from `pr`, `repo`, `checks` and `label`. Both modules must be on in **Menu → Extensions**.

## Limits and rules

- **Lancet Guard:** every tool call of every round goes through the guard. If the guard asks a person, the round waits for that person, and the deadline does not cut it short. A free check command runs unasked, with the owner's rights, and the guard does not see it, so only the owner can set or resume a goal with a free check.
- **Plan mode:** a goal does not start in plan mode, and it pauses before a round when plan mode is on.
- **Worker:** the model must be in the owner's allowed list for subagents. `resume` checks the list again, because it can change.
- **Who:** anyone who can steer the session runs `/team-shift`; a check needs the owner. One goal per session.
- **Size:** objective and condition together are 3000 characters. A check is 2000 characters, runs for 10 minutes at most, and keeps the last 3000 characters of its output.
- **2 internals:** a shift reads Pi Pocket's `pocket.plan` document and the request-id format `p:<person>:…`. Neither is public API, so a Pocket upgrade can break it. Both fail safe, as the reference page says.

## Old names

The feature was called "night shift". It runs at any hour, so it is now "shift".

- `/night-shift` still works: it does what `/team-shift` does, and each answer starts with "`/night-shift` is now `/team-shift`."
- `night_shift` in `team_delegate` still works: it takes the same fields as `shift`.
- The command is `/team-shift`, not `/shift`: Pi Pocket requires a `-` in an extension command name.
- The file `night-shift.ts`, the folder `night-shift-web/`, the module name in **Menu → Extensions**, and the stored names (`x.night-shift.goal`, `x.night-shift.driver`) keep the old name: they are stored data or live identity.

## Read more

The reference page is [Shift](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/shift.md), with [commands](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/shift.md#commands), [a start time](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/shift.md#a-start-time), [when it stops](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/shift.md#when-it-stops), [limits and rules](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/shift.md#limits-and-rules), [delegated shifts](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/shift.md#delegated-shifts), [old names](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/shift.md#old-names) and [caveats](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/shift.md#caveats).
