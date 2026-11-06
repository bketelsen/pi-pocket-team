# Documentation

Docs are split by the question they answer:

| Directory          | Question                             | Contents                                                                                                                               |
| ------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| [adr/](adr/)       | **Why** did we choose this?          | Architecture Decision Records: immutable once accepted; superseded, never edited. Org-wide decisions are in [org-adrs.md](org-adrs.md) |
| [design/](design/) | **How** does it fit together?        | Living documents that describe the current architecture                                                                                |
| [specs/](specs/)   | **What exactly** is the contract?    | Precise, testable interface definitions                                                                                                |
| [plans/](plans/)   | **When, in what order** do we build? | Plans and phases; updated as work lands                                                                                                |

The docs from before this shape stay where they are, because code comments cite their paths (frostyard/core ADR-0025:
"indexed as-is and categorized opportunistically, not force-moved"). Each one is in the index below, under the category
it fits.

## Index

### Decisions (ADRs)

- [0001 — Record architecture decisions](adr/0001-record-architecture-decisions.md)
- [0002 — Agent-portable instruction surface](adr/0002-agent-portable-instruction-surface.md)
- [0003 — Verify gate, risk paths and corrections](adr/0003-verify-gate-risk-paths-and-corrections.md)
- [Org-wide decisions (frostyard/core ADRs)](org-adrs.md)

### Design

- [beacon.md](beacon.md): the direction for every change (collect, analyze, act), Brian, 2026-11-04
- [desk-dashboard.md](desk-dashboard.md): the Desk page's Dashboard view, its 2 routes and how each metric is counted
  (`desk-web/dashboard.js` cites it)
- [terminal.md](terminal.md): the Terminal rail page: the long poll, the pty helper and the owner-only routes

### Specs

_(none yet)_

### Plans

These are the designs of the Desk and Team features, each with its status line. Code comments cite
`plans/daily-audit.md` (`audit/daily.mjs`, `audit/checks.mjs`) and `plans/plan-threads.md` (`desk.ts`,
`desk-consults.test.ts`).

- [clerk.md](plans/clerk.md): the Clerk, a second named agent that takes routine desk traffic off the supervisor
- [daily-audit.md](plans/daily-audit.md): the daily audit of the team's work (`audit/`); its trial script is
  `plans/daily-audit/trial.mjs`
- [desk-digest.md](plans/desk-digest.md): batched desk news to the supervisor
- [desk-noise.md](plans/desk-noise.md): handled reports, and quiet wakes of done sessions
- [issue-queue.md](plans/issue-queue.md): Brian puts a GitHub issue in the team's queue
- [plan-threads.md](plans/plan-threads.md): plan threads, an idea becomes a settled plan before work starts (PR 1 to
  PR 3 built; sections 15 to 17 name what is left)
- [pocket-journal.md](plans/pocket-journal.md): a daily note of the team's finished work, in frostnotes

### Module reference

The full reference of each module: what it does, its settings, routes, stored data, limits and tests. The user site
summarizes these pages.

- [modules/overview.md](modules/overview.md): the modules and their files, and the direction
- [modules/team.md](modules/team.md): Team: named agents, delegation, repository ownership, agent homes and memory
- [modules/desk.md](modules/desk.md): Desk: threads, asks, the sweep, `seed.json`, the page and the Dashboard
- [modules/night-shift.md](modules/night-shift.md): Night shift: commands, the start time, rounds, stops and limits
- [modules/model-router.md](modules/model-router.md): Model router (shadow): settings, what is sent, tiers, the record
- [modules/homewiki.md](modules/homewiki.md): Homewiki: the Wiki rail page
- [modules/terminal.md](modules/terminal.md): Terminal: the shell page and its limits
- [modules/github-hooks.md](modules/github-hooks.md): GitHub hooks: the webhook listener, its checks, facts, documents and alarms
- [modules/daily-audit.md](modules/daily-audit.md): the daily audit script
- [modules/home-seed.md](modules/home-seed.md): the agent home seed script
- [setup.md](setup.md): the requirements, the setup and tests of a checkout, and the install

### Runbooks

- [team-vm-cutover.md](team-vm-cutover.md): the 2026-10-27 move of the Pi Pocket server, its drop-ins and the
  agent homes to the team VM; its path script is `team-vm/rewrite-paths.mjs` (tested by `npm test`)
- [team-vm/cutover-2-7.md](team-vm/cutover-2-7.md): the copy-paste commands for steps 2 to 7 of that runbook

## Conventions

- **New docs start from their category's `TEMPLATE.md`** (in each directory).
- New decision → new ADR with the next number; if it reverses an old one, mark the old one `Superseded by NNNN` rather
  than editing it.
- Design docs are updated in place to always reflect reality.
- Specs change only alongside the code that implements them.
- Cross-links between categories are mandatory in both directions: see the documentation rules in
  [AGENTS.md](../AGENTS.md) (`CLAUDE.md`, `GEMINI.md`, `.cursorrules` and `.github/copilot-instructions.md` are symlinks to
  it, ADR-0002).
- Adding a doc means adding it to the index above.
