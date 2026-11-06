# Desk

One thread for each piece of work the team runs in the background: T13, T14, … A thread holds the work, its agents, its repository, its PRs, its asks, its dated check, its events and its reports. `team_delegate` opens the thread before the linked session starts, and the desk closes it when every part is closed.

Files: `desk.ts` and `desk-web/`. The tools are `desk`, `team_delegate` and `team_message`; the page is "Desk" on the rail, with a badge.

## The page

**Desk** is the owner's inbox, phone first. Its sections:

- **Needs you:** each ask with an **Answered** button and an optional field for the words, and the PRs ready to merge.
- **Ready to merge:** each PR with the label `ready-for-human`: its ref, title, head, thread, agents and CI state. Brian merges them there; Odrade files no ask for a merge.
- **Found, Stale, Watching, Working, Waiting on review, Parked:** attach or drop, keep, park, wake, and a dated check with Pass and Fail.
- **Other PRs** and **Closed in the last 7 days**, both collapsed.

The header counts what needs you, what is ready to merge, what is open, stale and parked, and how many threads count. A second view of the page is the **Dashboard**: the numbers of Desk-tracked work for 1 range and 1 scope. Its definitions are in [docs/desk-dashboard.md](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/desk-dashboard.md).

## The tools

A session with a supervisor identity uses `desk`; another session is refused.

- `list` and `read`: one line for each open thread, or one thread in full with its agents, repository, sessions, PRs, asks, the last 10 events and the reports.
- `sync`: sweep the threads now.
- `seed`: import a `seed.json` file once.
- `attach`, `detach`, `own`: put a PR or another thread's work on a thread, take a PR off it, or mark a found PR thread as Brian's own.
- `ask`, `answer`, `rewrite`, `withdraw`: file a question for Brian, record his words, give an open ask new words, or end one he need not answer.
- `watch`, `result`: sleep a thread until a date or an event, and record the pass or the fail.
- `archive`: the one-time sweep of the idle sessions of closed threads.

An agent session can use `read`, `watch` and `result` on its own thread only. A Clerk has its own smaller list.

## Asks, watches and the cap

- **Asks.** A decision, a host action or a device check that exists only in words is filed as an ask, `T13c`. Options give 2 to 6 choices for a pick-one decision. A done or blocked report must say its asks, and `asks: []` is the agent's word that nothing waits on Brian.
- **Watches.** A thread sleeps until a check date, or until an event and the date as its fallback, with a 1-line check. A sleeping thread does not count toward the cap and is never stale. A pass closes the thread as done; a fail opens it again.
- **The cap.** 12 open threads count by default, and `cap` in the config file sets 1 to 100. A reviewer wait and a parked thread do not count; a found thread does. Over the cap, `team_delegate` refuses new work until Brian allows 1 more, on the page or with `desk ok` in a supervisor session.

## The sweep

A `x.desk.sweeper` task sweeps each supervisor's threads every 10 minutes. Its reads are outside any commit, then it writes 1 commit:

- it reads the linked sessions, the subagents, each thread session's night shift, the git state of each folder and its worktrees, and GitHub: 1 GraphQL call for a small desk, and queries of at most 10 repositories and 20 PRs, 1 after the other, for a big one; a part that GitHub cut is read again 1 time, and a part still not read is named in `desk list`;
- it attributes a PR to a thread by 3 rules in order (the PR was seen in the session, or exactly 1 thread made its branch, or exactly 1 thread was open when it was made);
- it reads by number the PRs a session named when their repository's open list was not read whole, and only the seen and branch rules attach them;
- it computes the next actor (`brian`, `agent`, `odrade`, a `reviewer`, or `none`) and checks whether every part is closed. A thread is not done while the read left out a PR its session named, or, for a thread with no PR of its own, the open PRs of its repository: GitHub being down keeps such a thread open until a read works.

`desk list`, `desk sync` and the prompt section say `Unread: T12 (frostyard/x#5, 6 h)` for a PR link that no read gave facts for in more than 30 minutes, `GitHub: last read at 01:47, 6 h ago` when the read is that old, and `Sweep failed at 01:47: <why>` until the next good sweep. The page header shows only the `Unread: …` line.

The sweep also wakes an agent when every PR on its thread is merged or closed, tells a session once when its PR conflicts or its checks fail, removes the label `ready-for-human` when the PR changes after it, and archives the idle sessions of closed threads.

## Turn it on

Install the files, then turn on **Desk** in **Menu → Extensions**. Team must be on too: the `desk` tool reads identities and the roster through Team's API, and refuses with "The Team module is off." when Team is not loaded. Both modules reload into the running server; no restart is needed.

## Settings and storage

`PI_POCKET_DESK_CONFIG` names the config file, default `~/.config/pi-pocket-team/desk.json`, and every part reads it each time, so a change needs no restart. Its keys include `authors`, `ownAuthors`, `cap`, `export`, `exportCommit`, `digest`, `queue`, `journal`, `plans` and `archive`.

2 Pocket documents hold the desk: `x.desk.threads` (the app-wide desk) and `x.desk.reports` (one thread session's full reports). They are stored data: never rename a kind or change what a field means. The page and its routes are owner-only.

## Read more

The reference page is [Desk](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/desk.md), with [what these parts do](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/desk.md#what-these-parts-do), [seed.json](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/desk.md#seedjson), [turn it on](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/desk.md#turn-it-on) and [the module, complete](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/desk.md#the-module-complete). The designs are `docs/plans/clerk.md`, `docs/plans/plan-threads.md`, `docs/plans/issue-queue.md` and `docs/plans/pocket-journal.md`.
