# Brian's Pi Pocket extensions

This is Brian's extension project: drop-in modules for his running Pi Pocket server. See README.md for what each module does. The docs start at [docs/README.md](docs/README.md).

This file (`AGENTS.md`) is the canonical agent instruction file. `CLAUDE.md`, `GEMINI.md`, `.cursorrules` and `.github/copilot-instructions.md` are relative symlinks to it, and `.claude/skills` is a symlink to `.agents/skills/` ([ADR-0002](docs/adr/0002-agent-portable-instruction-surface.md)). Edit only the canonical paths.

## Skills

Repeatable procedures live in [.agents/skills/](.agents/skills/) (start from `.agents/skills/TEMPLATE/SKILL.md`). There are none yet.

## Code conventions

- **Direction:** read [docs/beacon.md](docs/beacon.md) (collect, analyze, act). A change that adds a module, a route, a prompt or a model choice says in its PR what it records, and where the audit reads it.
- **Modules:** Team (`team.ts`, `team-web/`), Homewiki (`homewiki.ts`, `homewiki-web/`), Night shift (`night-shift.ts`, `night-shift-web/`), Model router (`model-router.ts`), Desk (`desk.ts`, `desk-web/`), and Terminal (`terminal.ts`, `terminal-web/`). A new module also goes in `MODULES` in `install.mjs`, the `test` script in `package.json`, and `files` in `tsconfig.json`.
- **Docs:** Pi Pocket's extension docs start at `_pocket/docs/extensions.md`; the exact types are `_pocket.d.ts` (a link into the checkout). Read the guide your change needs before writing it.
- **Test before install, every time.** Run `make verify` before every commit and every install. It runs the template gate (`node scripts/check-template.mjs`), then `npm run lint` (`npm run format` fixes it), `npm test` (node --test, the template gate's own tests included, plus `node --check` of the browser modules) and `npm run typecheck`. `install.test.mjs` fails when a `*.test.*` file is missing from the `test` script. CI job `Test` runs `make ci`, which also checks that `.memory/corrections.jsonl` is append-only against the PR base; run `make ci BASE=origin/main` for the same check locally. `mise.toml` and `mise.lock` pin Node.
- **Installs are live.** `npm run install-extension` writes into `~/.pi-pocket/extensions/`, and a saved module reloads into the running server the whole team works in. Run `npm run install-check` first and make sure every file it lists is one you meant to change. If an installed file differs from the project's and you don't know why, stop and ask: someone may have edited the live copy.
- **Brian turns modules on and off, and restarts the server.** Never enable or disable an extension or restart the server; finish, test, and tell him what needs doing.
- **Tests stay isolated.** They use the Pi Pocket checkout's test harness (temporary data, test credentials, a fake model). Point modules at fixtures with environment variables (`PI_POCKET_TEAM_AGENTS`, `PI_POCKET_HOMEWIKI_ROOT`), never at Brian's real data.
- **Nothing secret in git.** `node_modules`, `_pocket.d.ts` and `_pocket` are links into the Pi Pocket checkout made by `npm run link` (`PI_POCKET_CHECKOUT`, default `../pi-pocket`), and stay ignored. Never commit anything from `~/.pi-pocket` or `~/.config/pi-pocket-team`, tokens, or credentials.
- **Stored data is forever.** Document kinds (`x.team.identity`, `x.team.memory`, `x.night-shift.goal`), task names (`x.night-shift.driver`), and their fields are stored in Brian's sessions: never rename a kind or change what a field means; add new ones beside them.
- **Night shift is restart-safe by design.** Round messages use stable request ids, the round count moves in the commit that starts the round, and the check sits behind a started memo. The wait before `start` is a restart-safe in-phase wait in the driver's `wait` phase (not `runtime.sleepUntil`: a stop must end it at once). `night-shift.test.ts` covers each rule (each stop reason, and a restart during the wait): keep it so when you touch the driver. Never make it pick a model or call a judge model.
- **Agent memory follows Pi Pocket's memory rules** (`src/server/memory.ts` in the checkout): Pi proposes, the owner approves, approvals check what the owner saw, and a replayed tool call never adds twice. Keep `team-memory.test.ts` covering each rule you touch.
- **Team reaches Night shift only through the global `Symbol.for("pi-pocket-team.night-shift")`, never by an import** (an import keeps a stale copy after a reload, and a second driver definition). `team-night-shift.test.ts` covers delegated goals: the goal, the report back, replay, the refusals, and the start wait.
- The homewiki's content belongs to Bellonda; this module only renders it.

**Test reliability.** No sleeps for timing (wait on a condition or inject a clock). No network and no wall clock in unit tests (inject them). A flaky test gets an issue, then a fix or a quarantine (skip with the issue link) in the same PR. Never retry a job or a test until it is green.

**Blocker to guard.** When a review (agent cross-review, owner review, or a human) finds a blocking point, the PR that fixes it also adds a guard: a targeted test that fails without the fix (preferred), or an `AGENTS.md` rule when no test can catch it. The same PR appends 1 line to `.memory/corrections.jsonl` (`evidence`: the PR and the review; `promoted_to`: the test or the rule). See `.memory/README.md`.

**Risk paths.** `.github/risk-paths.json` lists the high-risk paths; a PR that touches one gets `risk:high` from `.github/workflows/risk-paths.yml` and declares tier 3. Add a path when you add a file of that kind (signing, auth, publication, secrets, destructive operations, CI).

**Vendored files.** `scripts/lib/risk-paths.mjs` and `scripts/check-corrections.mjs` are copies from frostyard/core; never edit them by hand (`make verify` checks their hashes). `scripts/check-template.mjs` and `test/check-template.test.mjs` are copies from bketelsen/agentic-template. Prettier and ESLint skip these copies (`.prettierignore`, `eslint.config.js`).

**Labels.** Issues are in GitHub Issues. The labels the team uses: `ready-for-human`, `risk:high`, `sweep`, `agent-queue`, `agent-urgent` and `needs-plan`.

## Releases and dependencies

- Tag format: none. This repository has no tags and no GitHub releases, and it needs none: nothing depends on a version of it.
- How a release starts: there are no releases. A change reaches the running server when Brian runs `npm run install-check`, then `npm run install-extension`, from a checkout of `main` (see "Installs are live" above). Agents never install unless Brian asks.
- Who tags: Brian. Agents never tag, push tags, or release.
- Version rule: none. `package.json` keeps `version` at `0.1.0`, and `private: true`: it is never published.
- Internal dependencies: the Pi Pocket checkout (bketelsen/pi-pocket, upstream TannerMidd/pi-pocket). `npm run link` links `node_modules`, `_pocket.d.ts` and `_pocket` into it (`PI_POCKET_CHECKOUT`, default `../pi-pocket`). There is no version pin in `package.json`. CI pins it in `.github/workflows/ci.yml` (`git clone --branch v0.27.0`): move that tag when the server moves to a new Pi Pocket release. `.github/workflows/upstream.yml` tests against upstream `main` each Monday and only warns. README.md names the oldest Pi Pocket release that works (v0.21.0).
- Who uses this repository: only Brian's running Pi Pocket server, through `~/.pi-pocket/extensions/`. No other repository depends on it.

## Documentation rules

Docs live in `docs/` in 4 categories ([docs/README.md](docs/README.md), frostyard/core ADR-0025). Every new doc starts from its category's `TEMPLATE.md`:

- `docs/adr/`: why we decided. Immutable once Accepted; a reversal is a new ADR that marks the old one Superseded. A decision that binds only this repository gets an ADR here; an org-wide one goes to frostyard/core and a line in [docs/org-adrs.md](docs/org-adrs.md).
- `docs/design/`: how it fits together. Living; updated in place to match the code.
- `docs/specs/`: exact contracts. Change only with the code that implements them.
- `docs/plans/`: order of work, with "Done when" outcomes.

The docs that came before this shape (`docs/*.md`, `docs/plans/*.md`, `docs/team-vm/`) stay where they are, because code comments cite their paths; they are indexed as they are, and move only with the change that updates those comments.

- A new doc gets a line in the index in [docs/README.md](docs/README.md); `make verify` fails on a doc under `docs/` that the index does not link.
- Cross-links go both ways: an ADR links the design docs and specs it shapes; a design doc links its ADRs and specs; a spec links its ADRs and design doc; a plan links what it builds. When you touch a doc, check its links and add the back-links. Use relative paths.
- Write absolute dates, not relative ones.
