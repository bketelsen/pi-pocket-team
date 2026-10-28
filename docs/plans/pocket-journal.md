# PocketJournal: a daily note of the team's finished work, in frostnotes

Status: design by Sheeana, 2026-10-28, for Brian's request of the same day: "get an mcp connection to my
live lodge frostnotes server and add a PocketJournal folder with one note per day, every completed task
gets appended to it with a link to any PR that was merged and a 1-3 sentence human-friendly description
of the work." Implemented in `desk.ts`.

## 1. The connection

Facts from frostnotes and lodge (`~/projects/frostyard/frostnotes/docs/specs/mcp.md`, frostnotes
ADR-0026 and ADR-0028, lodge ADR-0006):

- frostnotes' hub (`notesd --lodge`) is lodge's `notes` app. Agents on the tailnet reach its MCP tools at
  `https://lodge.goat-snake.ts.net/mcp/notes` (Streamable HTTP). The team VM is on the tailnet and sees
  the node `lodge`.
- lodge checks: `Host` is lodge's name, no `Origin` header, the peer is on the tailnet, and
  `Authorization: Bearer lgm_…` names a live token for app `notes`. A bad token is 401.
- A token is issued on lodge's host only, and printed once:
  `sudo lodgectl token issue NAME --app notes --scope SCOPE`. Its name is the author of every write it
  makes, and `note.revert` undoes each write.
- The scope is notes' own, enforced in notesd's engine (ADR-0028). The journal needs only
  `vault=<id>;write=PocketJournal/`: it reads the whole vault (notes reads stay whole-vault), and writes
  only under `PocketJournal/`. Under that scope, `read_note`, `create_note` and `edit_note` are offered.
  `<id>` is the vault's ID on the hub (`sudo -u frostnotes notesctl vault list`).

The journal does not use `append_to_daily_note`: that tool writes the vault's own daily note (its
template and folder), and under a folder scope only today's. The journal writes its own notes,
`PocketJournal/YYYY-MM-DD.md`, with `create_note` and `edit_note` (`append`).

**Two connections, two tokens.** Brian asked for "an MCP connection". There are 2 uses, and each gets
its own token, so each has only the scope it needs:

1. **The journal writer** (this design): server code in `desk.ts`, which calls the MCP tools itself
   with `@earendil-works/pi-mcp`'s `StreamableHttpTransport` (no GET stream). Token name
   `pocket-journal`, scope `vault=<id>;write=PocketJournal/`.
2. **Optional: the agents' tools.** An entry `notes` in `~/.pi/agent/mcp.json` (the MCP drop-in's
   file), which gives Pi `mcp_call` on the notes tools after Brian turns it on in the MCP page. Its
   scope is Brian's choice: read only (`vault=<id>`) is the safe start. Not needed for the journal.

The token is a file, never a value in git or in `desk.json`: `~/.config/pi-pocket-team/journal-token`
(mode 0600), read at each write. Brian can issue it straight into the file, so it never shows on a
screen (section 7).

## 2. What a "completed task" is

A desk thread that closes as done with outcome `completed` (every PR merged, or no PR) or `verified`
(a watch passed). Not `abandoned` (a PR closed unmerged), not `frozen`, and not a thread closed
`dropped` (Brian's drop, Brian's own PR) or `failed`.

The hook: `journalClosed(tx, state, thread, now)`, called in the same commit as each place that sets
`thread.closed = { why: "done" }`:

- the sweep's close (`applySweep`, the `closeCheck` loop);
- `recordResult` with a pass, from the `desk result` tool;
- `recordResult` with a pass, from the page's `threads/:id/result` route.

It enqueues 1 journal item and sets `thread.run.journaled` (the time) in that commit. A thread that has
`run.journaled` is never enqueued again: a thread that reopens and closes again gets no second entry.

The journal is off without a `journal` key in `desk.json`: nothing is enqueued, and every path works
as before.

## 3. The entry

```markdown
## 14:32 · Sheeana · Desk journal for finished work

<!-- pocket-journal:T42 -->

PRs: [bketelsen/pi-pocket-team#68](https://github.com/bketelsen/pi-pocket-team/pull/68)

The desk now writes a short note to frostnotes each time a piece of team work is finished. Each day
gets its own note in the PocketJournal folder, with links to the merged pull requests.
```

- **Heading:** the close time (`HH:MM`, America/New_York), the agents' names (Team's roster names, else
  the ids), and the thread's title.
- **Marker:** `<!-- pocket-journal:<thread id> -->`, hidden in a rendered note. The writer reads the note
  first, and appends nothing when the marker is there: a write whose answer was lost (a timeout, a
  restart) is not written twice.
- **PRs:** every PR of the thread that is `MERGED` and not guessed (`via: "window"`), as a Markdown
  link `[owner/name#n](url)`. No line when there is none.
- **Sentences:** 1 to 3 plain sentences (section 4).
- **Text from outside** (titles, PR titles, the sentences) goes through `journalPlain`: 1 line, `<` and
  `>` as entities, `\` and `[` and `]` escaped, and no Markdown mark at its start. So only the writer writes a
  marker, and a title or a model answer cannot add a heading. The marker counts only alone on its line.
  A PR link is a link only when its URL is `https://github.com/<owner>/<name>/pull/<n>`.
  A bare address in a title can still show as a link (GitHub Markdown links it by itself), but its
  text is the address: it hides nothing.

The item that the commit enqueues holds all of this, so the writer needs nothing else from the desk:
thread id, title, agents, repo, close time, outcome, merged PRs (`ref`, `url`, `title`), and the text of
the thread's newest report (from `x.desk.reports`, cut to 4,000 characters).

## 4. Who writes the sentences

**Recommended: a cheap model, with the template as the fallback.**

- The model is a setting, `journal.model` (`provider/modelId`). Recommended:
  `deepseek/deepseek-flash`, Brian's choice for the daily audit's LLM step. Empty: the template only.
- 1 call per entry, with no tools: the system prompt says the input is data, and asks for 1 to 3 plain
  sentences for a person, with no links, names of files, or Markdown. The input is the title, the PR
  titles and the report (at most 4,000 characters, about 1,200 tokens); the output is at most 300 tokens.
  Cost: about $0.001 per entry with deepseek-flash.
- Caps in code: at most 50 model calls a day (`journal.dailyCalls`); then the template.
- Code checks the answer: 1 paragraph, 1 to 3 sentences, at most 600 characters, no `<`, no `](`, no
  backticks. Any failure (no sign-in, an error, a timeout of 60 s, a bad answer) gives the template.
- The call uses Pi's model runtime as `audit/llm.mjs` does (`ModelRuntime` of
  `@earendil-works/pi-coding-agent`). Pocket's spend view does not count it.

The template: "{Agents} finished “{title}”{ in {repo}}." When PRs merged: "{n} pull request(s) merged:
{PR titles, joined}." For `verified`: "A dated check passed." That is 1 to 3 sentences, always.

The sentences are made once, before the write, and kept in the writer task's checkpoint: a restart
writes the same text. The model call starts at most once: the checkpoint drops the model before the
call, so a restart during it gives the template, and the day's count stays true.

## 5. The note

- Path: `{folder}/{YYYY-MM-DD}.md`, `folder` default `PocketJournal`, the day of the close time in
  `journal.timeZone` (default `America/New_York`). An entry that waited (lodge down) still goes in the
  day it closed.
- Vault: the one the token's scope names. **Brian picks it** (ask).
- A missing note is made with `create_note`: `# PocketJournal YYYY-MM-DD`, a blank line, then the entry.
  When `create_note` answers that the note exists (a race), the writer reads it and appends.
- An existing note: `read_note`, check the marker, then `edit_note` with `append`. notesd merges with
  any edit made meanwhile, and never changes text that is there.
- Entries go in close order: 1 writer, first in first out. An item that fails blocks the ones behind
  it, so the order in a note never breaks.

## 6. When lodge is down

Nothing is lost. The queue is in `x.desk.threads` (`journal.items`), and an item leaves it only in the
commit after its write succeeded, or after the marker was found.

The writer task `x.desk.journal` (1 for the desk, recorded in `journal.writer`, owned by the supervisor
conversation of the item that started it):

1. `take`: the first item; none ends the task (and clears `journal.writer`) in the same commit.
2. `compose`: the sentences (section 4), committed into the checkpoint.
3. `write`: connect, read, create or append, close. Success removes the item, resets `failures`, and
   goes back to `take`.
4. On a failure (no token file, lodge or notesd down, 401, a tool error): `failures` + 1, `lastError`
   (a fixed text for an HTTP status, else the first line with the token, any `lgm_…` value and any
   Bearer value taken out), and a durable wait (`runtime.sleepUntil`) of
   `min(5 min × 2^(failures−1), 2 h)`, then `write` again with the same text.
5. At the 3rd failure in a row, 1 notice to the owner: the journal waits, with the reason. `desk list`
   says how many entries wait while `failures` > 0.

Restart safety: each phase starts from its checkpoint. A restart in `write` writes again, and the marker
makes it act once.

The journal turned off with entries waiting: the writer ends and keeps them. When it is on again, the
next sweep, `desk sync`, or close starts a writer for them, also with no open thread.

## 7. Settings and Brian's steps

`desk.json`, new key `journal` (read at each use):

```json
{
    "journal": {
        "url": "https://lodge.goat-snake.ts.net/mcp/notes",
        "folder": "PocketJournal",
        "model": "deepseek/deepseek-flash",
        "timeZone": "America/New_York",
        "dailyCalls": 50
    }
}
```

Only `url` is required (an `https://` URL; `http://` only for `localhost` and `127.0.0.1`, for tests).
`tokenFile` can name another token file. `PI_POCKET_DESK_JOURNAL_TOKEN` names it in tests.

Brian's steps (he holds the credentials):

1. Pick the vault, and find its ID on the hub: `sudo -u frostnotes notesctl vault list`.
2. Issue the token straight into the file on the team VM, so it never shows:
   `ssh <lodge host> sudo lodgectl token issue pocket-journal --app notes --scope 'vault=<id>;write=PocketJournal/' > ~/.config/pi-pocket-team/journal-token && chmod 600 ~/.config/pi-pocket-team/journal-token`
3. Add the `journal` key to `desk.json`.
4. Install the new `desk.ts` (`npm run install-extension`); it reloads live.

## 8. Tests (fakes only)

No test calls lodge. A fake MCP server on `127.0.0.1` (node `http`, JSON answers) implements
`initialize`, `tools/call` for `read_note`, `create_note` and `edit_note`, and records each call. The
tests cover: each close path enqueues once; the abandoned, frozen, dropped and failed closes do not; a
reopen and close again does not; the journal off enqueues nothing; a missing note is created, an
existing one appended; the marker stops a second write; a server that is down, then up, gets every
entry in order after the wait; a 401 waits and keeps the item; the template; the model answer's checks,
with a fake `complete`; the day in America/New_York near midnight.
