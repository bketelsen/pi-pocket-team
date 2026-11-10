# Desk

One thread for each piece of work the team runs in the background: T13, T14, … A thread holds the work, its agents, its repository, its PRs, its asks, its dated check, its events and its reports. `team_delegate` opens the thread before the linked session starts, and the desk closes it when every part is closed.

Files: `desk.ts` and `desk-web/`. The tools are `desk`, `team_delegate` and `team_message`; the page is "Desk" on the rail, with a badge.

## The page

**Desk** is the owner's inbox, phone first. Its sections:

- **Needs you:** each ask with an **Answered** button and an optional field for the words, and the PRs ready to merge. An ask's text shows as Markdown: lists, bold, `https:` links, and code. A long command (41 characters or more in backticks, also in bold) gets a box of its own with a **Copy** button; code in a link's text stays in the line. A tap on `artifact:<id>` opens the supervisor's session, and a tap on a desk path such as `reports/…/x.md` opens that file, read only.
- **Ready to merge:** each PR with the label `ready-for-human`: its ref, level, title, head, thread, agents and CI state. The level comes from the `level:L1` to `level:L4` labels, and is `L1/L2` when the PR has `risk:high` and no level label. The order is L4, L3, L2, L1/L2, L1, then no level; inside a level, the oldest label first, then by ref (see [ADR-0078](https://github.com/frostyard/core/blob/main/docs/adr/0078-sort-pull-requests-by-levels-l1-to-l4.md)). A cut label list keeps the last level. Brian merges them there; Odrade files no ask for a merge.
- **Found, Stale, Watching, Working, Waiting on review, Parked:** attach or drop, keep, park, wake, and a dated check with Pass and Fail.
- **Other PRs** and **Closed in the last 7 days**, both collapsed.

The header counts what needs you, what is ready to merge, what is open, stale and parked, and how many threads count. A second view of the page is the **Dashboard**: the numbers of Desk-tracked work for 1 range and 1 scope. The 3 views (Desk, Dashboard, Board) have the same width, so the switch between them stays in 1 place. Its definitions are in [docs/desk-dashboard.md](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/desk-dashboard.md).

## The tools

A session with a supervisor identity uses `desk`; another session is refused.

- `list` and `read`: one line for each open thread, or one thread in full with its agents, repository, sessions, PRs, asks, the last 10 events and the reports.
- `sync`: sweep the threads now.
- `seed`: import a `seed.json` file once.
- `attach`, `detach`, `own`: put a PR or another thread's work on a thread, take a PR off it, or mark a found PR thread as Brian's own.
- `ask`, `answer`, `rewrite`, `withdraw`: file a question for Brian, record his words, give an open ask new words, or end one he need not answer.
- `watch`, `result`: sleep a thread until a date or an event, and record the pass or the fail.
- `archive`: the one-time sweep of the idle sessions of closed threads.
- `board`, `board_add`, `board_edit`, `board_drop`, `board_pick`, `board_unpick`, `board_launch`, `board_reopen`, `board_resolve`: the goal board (below).

Plans have a tool of their own, `plan`. After Brian approves a plan, 2 of its actions close gaps without a new approval:

- `plan amend`: a text-only correction of an approved plan. The planning session writes it, with a why; the plan keeps its state, its approved graph and its tasks, and the change shows on the Desk page under the changes since the approval. It never changes Decisions, Tasks, the sections, a heading or the title. A supervisor's `plan amend` is only a request: the desk sends it to the planning session, which writes it in its own words.
- `plan drop`: the supervisor closes a plan that Brian stopped. It names Brian's answered ask that says stop or drop, on the plan thread or on one of its task threads. An open ask on the plan thread still refuses the drop. The open tasks stop, and their sessions get the stop.

A pass on a plan task thread with no PR and no `plan nochange` is refused (see Watches below).

A task thread that closes as done with no PR gets 1 grace sweep to find it. A sweep without a GitHub read cannot spend grace. A read cut short for any repository of the task thread cannot spend grace either. A read that stays cut for the thread's repository keeps the task delegated in its grace; `desk attach` or `plan revise` recovers it. `desk attach` to its recent stopped attempt's thread lets a later merge repair the task, and its event says not to deliver the task again while the PR is open. Tasks with `after: "closeout"` stay delegated until the thread closes as done strictly after the desk records the merge, so host steps finish before deps or verification start. The merge observation is the later of the sweep time and the close time of a thread already closed, also for a repair. An earlier or simultaneous close does not count: reopen with `desk watch` and record a pass after the host steps, or recover with `plan revise`.

An agent session can use `read`, `watch` and `result` on its own thread only. On the goal board, an agent reads its supervisor's board with `board`, adds its own proposals with `board_add`, and edits or drops only its own proposed rows with `board_edit` and `board_drop`. A Clerk has its own smaller list, and escalates to its supervisor with `desk escalate`: the desk drops an escalation of news the supervisor already acted on or got, and puts the rest in her next digest, or sends it at once with `urgent: true`.

## Asks, watches and the cap

- **Asks.** A decision, a host action or a device check that exists only in words is filed as an ask, `T13c`. Options give 2 to 6 choices for a pick-one decision. A done or blocked report must say its asks, and `asks: []` is the agent's word that nothing waits on Brian.
- **PRs.** `team_message` takes `prs`: at most 100 PRs, each as `{ repo, number }`. The desk checks each one with GitHub and with the owners of the roster's repositories, then puts it on the thread, so a PR an agent only labelled or reviewed shows in **Ready to merge**. A PR it cannot attach, and why, is an event on the thread and a line in the tool's answer. A shift's summary writes 1 line `PRS:` with its PRs, or `PRS: none`.
- **Watches.** A thread sleeps until a check date, or until an event and the date as its fallback, with a 1-line check. A sleeping thread does not count toward the cap and is never stale. A pass closes the thread as done, and a message in its session from before the pass does not open it again; a fail opens it again. A pass is refused while the thread has an open ask, and on a plan task thread with no PR and no `plan nochange`, because its close would make the task ready again.
- **The cap.** 12 open threads count by default, and `cap` in the config file sets 1 to 100. A reviewer wait and a parked thread do not count; a found thread does. Over the cap, `team_delegate` refuses new work until Brian allows 1 more, on the page or with `desk ok` in a supervisor session.

## The sweep

A `x.desk.sweeper` task sweeps each supervisor's threads every 10 minutes. Its reads are outside any commit, then it writes 1 commit:

- it reads the linked sessions, the subagents, each thread session's shift, the git state of each folder and its worktrees, and GitHub: 1 GraphQL call for a small desk, and queries of at most 10 repositories and 20 PRs, 1 after the other, for a big one; a part that GitHub cut is read again 1 time, and a part still not read is named in `desk list`;
- it attributes a PR to a thread by 3 rules in order (the PR was seen in the session, or exactly 1 thread made its branch, or exactly 1 thread was open when it was made);
- it reads by number the PRs a session named when their repository's open list was not read whole, and only the seen and branch rules attach them;
- it copies a linked session's failed run (Pi Pocket 0.28.0 and later) to the thread, with the event `run failed: <line>`; while its session is idle and not archived, such a thread waits on Odrade with the reason `run failed: <line>`, and it does not close;
- it computes the next actor (`brian`, `agent`, `odrade`, a `reviewer`, or `none`) and checks whether every part is closed. A thread is not done while the read left out a PR its session named, or, for a thread with no PR of its own, the open PRs of its repository: GitHub being down keeps such a thread open until a read works.

`desk list`, `desk sync` and the prompt section say `Unread: T12 (frostyard/x#5, 6 h)` for a PR link that no read gave facts for in more than 30 minutes, `GitHub: last read at 01:47, 6 h ago` when the read is that old, and `Sweep failed at 01:47: <why>` until the next good sweep. The page header shows only the `Unread: …` line.

Every sync of a supervisor (the sweeper, `desk sync`, the page's view sweep, and a nudged sync) runs its reads and its commit in that supervisor's lane, 1 after the other, so an older read never commits after a newer one. A request during a sync waits in the 1 follow-up after it: requests of any kind join that follow-up, which reads GitHub once for all of them, and each caller still gets its own result. The page's view sweep does not wait: when the lane is busy, the page shows what the desk has.

A hooks module can hand the desk facts of GitHub webhook deliveries with `nudge` on the desk's API. The desk takes each delivery id once (a redelivery changes nothing). A fact about a PR or an issue on a thread (a CI suite fact names every PR of the suite), a PR a watch waits for, a PR head, or the issue queue makes that supervisor's next sync come early: 20 seconds after the first fact, and at most 1 such sync in 60 seconds, by the durable task `x.desk.nudge`. So 50 deliveries in 20 seconds are 1 sync. The fact only decides when to read: the sync's own GitHub read is the truth. Each sweep also records the changes it saw on PRs and queued issues (state, labels, review, head, CI), for a later alarm that compares them with the deliveries.

The sweep also wakes an agent when every PR on its thread is merged or closed, tells a session once when its PR conflicts or its checks fail, removes the label `ready-for-human` when the PR changes after it (or wakes the agent once when core's `pr-triage` workflow already removed it after a push), and archives the idle sessions of closed threads.

## The goal board

Each supervisor has 1 board of shift rows: goal runs at any hour, each with an agent, an optional repository, a title, the task, a stop condition, at most `max` rounds, and an `until` time (optional: `start`, `worker`, a PR check, a kind, a note and an order). Agents add their own proposals as rows, Odrade orders and notes them, Brian picks, and 1 launch request starts the picks in code, under the limits. No model launches a run.

- **States.** `proposed` → `picked` → `waiting` (a launch request) → `starting` → `launched`, `failed` or `unknown`; a full desk sends a row back to `waiting`. A row can be dropped before it starts, unpicked, and reopened after a failure. An edit of a picked or waiting row sends it back to `proposed`.
- **Revisions.** Each row has a `rev`, 1 more at each edit. A pick, an unpick and a launch name each row with the `rev` they read; another `rev` is refused: `Row 3 changed (rev 4 now): read it with desk board, then pick again.` A replayed tool call changes nothing: each call that changes the board keeps a receipt for 30 days (`x.desk.board-receipts`), with no count limit.
- **Text limit.** A shift takes at most 3000 characters of objective (the task when the row has none) and stop condition together. An add, an edit or a pick of a row over that is refused at once, with the counted length, so the row does not fail only at its launch. With the shift module off, or an older one, the board does not check it, and the launch refuses the row as before.
- **Who does what.** The supervisor changes its own rows only. An agent adds rows for itself, without note or order, to the 1 live supervisor (one with an open thread, a sweeper, a Clerk, or a row that is not launched or dropped; a row that failed or is unknown keeps its supervisor on the board, so it can be reopened or resolved), and changes or drops only its own proposed rows. A Clerk only reads the board. Picks, launches, reopens and resolves are the supervisor's.
- **Times.** In the server's zone, through the shift module. At the pick, the run's end is the next time the clock shows `until` (and its start the next `start`). The run stops at that instant in every path: Team gives the shift the absolute end (`until_at`), so a wait before round 1 (a `start`, or DeepSeek's peak hours) or a late start after a restart never moves it. A wait that ends after it ends the run with no round. A row with less than 10 minutes left fails.
- **The launch pass.** A launch request, each sweep and each `desk sync` run 1 pass: first the rows a restart left `starting`, then the waiting rows in order. At most `atOnce` rows run at once; the day's rounds stay within `rounds`; and the board never takes the last `reserve` slots below the cap, nor Brian's OKs. A row that does not fit waits for a later sweep, and its supervisor's sweeper stays for it.
- **Results.** A started row is `launched`, with its thread. A refusal (a model not allowed, a bad PR check, no such repository) is `failed`, with Team's words. A start that threw is `unknown`: it is never tried again by itself, and `board_resolve` binds the session's thread or fails the row. Each failed and unknown row sends the supervisor 1 `[desk] board row …` message at once.
- **The Board view.** The third view of the Desk page (Desk stays the default) shows 1 supervisor's board (by default the live supervisor with a sweeper, else the first; the choice names each supervisor by its session title and id): the limits now, then the rows in launch order with agent, repository, title, kind, `max`, `until`, note, state and rev, and a tap opens a row's task and stop condition. Each row's status has a color from the theme, beside its state words: blue while it runs (`launched (running)`), a dashed blue border while it waits, green when it finished (its thread closed or its shift ended), magenta when picked, red when failed, amber when unknown, and gray when dropped. Finished and dropped rows go in a closed **Done** fold below the list, newest first. Brian picks, unpicks, edits `max` and `until`, drops, reopens and resolves rows there, and **Launch picks** starts the picked rows. Each act carries the rev the page shows; a row that changed since is refused, and the view reads the board again. A repeated tap of the same act changes nothing. Each act's key starts with the page's time; a key 30 days old, or more than 10 minutes ahead of the server's clock, is refused (409: `This request is too old to replay: load the board again.`), and the view reads the board again. Only the owner can use it: anyone else gets 403. The export also writes the board to `board.md`.

## Run-end answers

Since Pi Pocket 0.28.0, when a linked session's run ends, Pocket sends its final answer to the session that started it, and that message starts a run there. The supervisor starts every desk-tracked session, and the reports already come by `team_message`, so the desk turns these answers off for each supervisor: Pocket's `linkedSessions.reports` with `take: false` (Pi Pocket 0.28.0-bk.1 and later). It holds for every session the supervisor started, old, new and archived. A `team_work` start from an agent's home keeps its answers: an agent's home is no supervisor.

- **When.** Team turns it off before each desk-tracked start: a delegated task, a shift, the Clerk, a plan start (from `team_delegate` or the page's **New plan**) and a plan consult. The desk also checks each supervisor at the first desk commit after a load (a sweep, a page view, or `desk list`), with 1 task `x.desk.reports-off` for each supervisor that has none.
- **Once.** A call that works is recorded in `reportsOff` (its time and the Pocket version), and that supervisor is never called again. The task of each supervisor is in `reportsOffTasks`, with the time it was made: a record older than 10 minutes is stale (its task ended with no cleanup), and the next check starts a new task.
- **A failure.** A refused call (plan mode, a spend limit, another person's turn) gives 1 warning notice in the supervisor's session, at most 1 an hour, and the next sweep tries again. The time of the last warning is stored in `reportsOffNoticed`, so a reload or a restart does not warn again within the hour. On a Pi Pocket 0.28 with no switch, nothing is called, and the supervisor gets 1 warning for each load, before its first desk-tracked start: `Automatic run-end answers are on: this session gets each linked session's run end.`
- **The line.** `desk list` and the prompt section say `Run-end answers: off since <time>`, or `Run-end answers: on (<reason>)` on Pi Pocket 0.28 and later: `Pi Pocket <version> has no switch`, `the switch failed: <error>`, or `the switch is not set yet`. An older Pi Pocket with no record shows no line.

## Turn it on

Install the files, then turn on **Desk** in **Menu → Extensions**. Team must be on too: the `desk` tool reads identities and the roster through Team's API, and refuses with "The Team module is off." when Team is not loaded. Both modules reload into the running server; no restart is needed.

## Settings and storage

`PI_POCKET_DESK_CONFIG` names the config file, default `~/.config/pi-pocket-team/desk.json`, and every part reads it each time, so a change needs no restart. Its keys include `authors`, `ownAuthors`, `cap`, `export`, `exportCommit`, `digest`, `queue`, `journal`, `plans`, `archive` and `board` (the goal board's limits: `atOnce` 8, `rounds` 250, `reserve` 2 and `keep` 14 days by default; a value out of its bounds falls back to its default with 1 warning).

These Pocket documents hold the desk: `x.desk.threads` (the app-wide desk, with the goal board), `x.desk.board-receipts` (the goal board's call receipts, 30 days), `x.desk.reports` (one thread session's full reports), `x.desk.nudges` (the delivery ids the desk took, the waiting nudges, and for each nudged sync its delivery times and its commit time) and `x.desk.observed` (the changes the sweeps saw, for the hooks' coverage alarm). They are stored data: never rename a kind or change what a field means. The page and its routes are owner-only.

## Read more

The reference page is [Desk](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/desk.md), with [what these parts do](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/desk.md#what-these-parts-do), [seed.json](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/desk.md#seedjson), [turn it on](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/desk.md#turn-it-on) and [the module, complete](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/desk.md#the-module-complete). The designs are `docs/plans/clerk.md`, `docs/plans/plan-threads.md`, `docs/plans/issue-queue.md` and `docs/plans/pocket-journal.md`.
