# Desk digest: batched desk news to the supervisor

Status: decided by Brian on 2026-10-23 (Odrade's cost brief: the supervisor session cost $177 of $493 a
day, and every wake-up reads her whole context again). Implemented in `desk.ts`, `team.ts` and
`night-shift.ts`.

## 1. What changes

Today each piece of desk news wakes the supervisor at once: each agent report (1 `[desk]` line from
`team_message`), each night shift report, each answer from the Desk page (`x.desk.notify`), and at the
end of each of her turns the `Desk queue:` continue. The daily audit of 2026-10-23 counted 224 reports,
46 close-out wake-ups and 43 queue continues in 24 hours.

With the digest, the desk collects this news per supervisor and sends it as 1 message, at most once in
each interval (default 15 minutes), and only when something is new. A few kinds still go at once.

## 2. Kinds

Each piece of news is 1 digest item of 1 kind. Stored data: never rename a kind.

| Kind            | Source                                                                                          | Default     |
| --------------- | ----------------------------------------------------------------------------------------------- | ----------- |
| `report`        | an agent's `team_message` report, filed on its thread                                           | digest      |
| `shift`         | a night shift report that stopped for any reason except `blocked` or `failed`                   | digest      |
| `shift-blocked` | a night shift report that stopped `blocked` or `failed`                                         | **at once** |
| `answer`        | Brian's Desk-page answer that is only an acknowledgement (`ok`, `no`, `thanks`, `later`, …)     | digest      |
| `answer-action` | any other Desk-page answer: it names something for the supervisor to do                         | **at once** |
| `closed`        | the sweep closed the thread: done, nothing remains                                              | digest      |
| `queue`         | a thread newly waits on the supervisor: a due watch, found work, a missing PR, a silent session | digest      |
| `repair`        | a thread newly waits on the supervisor for a repair that its agent cannot take (after the cap)  | **at once** |
| `issue`         | an issue that Brian queued on GitHub, newly (`issue-queue.md`)                                  | digest      |
| `issue-urgent`  | an issue newly urgent: the label `agent-urgent` by Brian                                        | **at once** |
| `issue-left`    | an issue with a thread left the queue while open, with proof                                    | digest      |

An "at once" item is not sent alone: it makes the next digest go now, with every item that waits.

The 3 issue kinds were added after the first 8: they go to the supervisor also with a Clerk (they are in no
default Clerk list), because only the supervisor plans shifts. The default `now` list gets `issue-urgent`.

## 3. Settings

`~/.config/pi-pocket-team/desk.json` (or `PI_POCKET_DESK_CONFIG`), new key `digest`:

```json
{ "digest": { "minutes": 15, "now": ["shift-blocked", "answer-action", "repair"] } }
```

- `minutes`: an integer from 0 to 240. Default 15. **0 turns the digest off**: every path works as
  before this change (immediate lines, the page answer's notify task, and the `Desk queue:` continue).
- `now`: the kinds that go at once. Unknown names are left out. Default as above.

A missing or bad value gives its default. The file is read at each use, so a change works without a
reload.

## 4. Timing

- An item that is not "at once" asks for a digest at `now + minutes`. An "at once" item asks for one at
  `now`.
- A digest task (`x.desk.digest`, 1 per requested time) sleeps until its time, then takes **all** the
  supervisor's waiting items and sends 1 message.
- A request is covered when a task is already scheduled at or before the requested time: no second
  task. So the gap between 2 digests without "at once" items is at least `minutes`, and an item waits
  at most `minutes`.
- A task that wakes to an empty box ends without a message.

## 5. The message

```
[desk] digest: 4 new. Read each with desk read <id> before you act.
[desk] T12 frostyard/x · lucilla reported (420 chars) · desk read T12 · "PR #41 merged, …"
[desk] T36 frostyard/y · closed: done, nothing remains · 1 report · desk read T36
[desk] T35 · waits on you: silent session · desk read T35
[desk] T39a answered by Brian: yes
```

- Each line keeps today's 1-line form (`shortLine`, `answeredText`).
- A thread closed in this digest gets 1 line: its `closed` line, with the count of its reports in the
  same digest. Its other report and queue lines are left out.
- At most 30 lines; the rest are counted: `… and 7 more on the Desk page.`

## 6. Storage

New optional fields only (stored data is forever):

- `DeskState.digests?: Record<supervisor id, DigestBox>`
- `DigestBox = { items: DigestItem[]; scheduled: number[]; queued: Record<thread id, reason>; seq: number; sentAt?: number }`
- `DigestItem = { key: string; thread: string; kind: DigestKind; line: string; at: number }`
- `StoredReport.held?: boolean`: the report went into the digest, so a replay of the `team_message` or
  night shift report also sends nothing.

`queued` holds the reason each thread waits on the supervisor that a digest already carried. A thread
that stops waiting leaves it; it comes back as a new item only when it waits again, or for another reason.

## 7. Restart safety

- Each item enters the box in the same commit as its cause: the filed report, the page answer, the
  sweep's close. `key` makes a second enqueue a no-op.
- The digest task takes the items and moves to `deliver` in 1 commit, with the text and a request id
  `x.desk.digest:<supervisor>:<seq>`. A restart in `deliver` submits again with the same request id,
  which acts once (as `x.desk.notify` does).
- `team_message` and the night shift report send nothing when the desk says `held`; a replay finds the
  stored report and its `held`, so it sends nothing again.

## 8. Callers

- `desk.file` takes `digest?: true` (the caller can hold its send) and `reason?` (the night shift's stop
  reason). Without `digest`, it works as before: an older `team.ts` or `night-shift.ts` still sends its
  line, and the box gets nothing. It returns `held: true` when the item went into the box.
- `team.ts` `team_message` and `night-shift.ts` `report` pass `digest: true`, and skip the send when
  `held` is true.
- The Desk page answer enqueues `answer` or `answer-action` instead of starting `x.desk.notify`.
- The sweep enqueues `closed` when it closes a thread as done, and `queue` or `repair` for each thread
  that newly waits on the supervisor.
- The supervisor's `Desk queue:` continue does not run while the digest is on: the digest carries new
  waits. The `Desk check:` ask reminder stays.
- Repair wake-ups to an agent, close-out wake-ups to an agent, and repair messages to Odrade from an
  agent's session are not desk news to the supervisor: they go as before.
