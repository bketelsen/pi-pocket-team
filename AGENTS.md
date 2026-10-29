# Brian's Pi Pocket extensions

This is Brian's extension project: drop-in modules for his running Pi Pocket server. See README.md for what each module does.

- **Modules:** Team (`team.ts`, `team-web/`), Homewiki (`homewiki.ts`, `homewiki-web/`), Night shift (`night-shift.ts`, `night-shift-web/`), Desk (`desk.ts`, `desk-web/`), and Terminal (`terminal.ts`, `terminal-web/`). A new module also goes in `MODULES` in `install.mjs`, the `test` script in `package.json`, and `files` in `tsconfig.json`.
- **Docs:** Pi Pocket's extension docs start at `_pocket/docs/extensions.md`; the exact types are `_pocket.d.ts` (a link into the checkout). Read the guide your change needs before writing it.
- **Test before install, every time.** Run `npm test` (node --test, plus `node --check` of the browser modules), `npm run typecheck`, and `npm run lint` (`npm run format` fixes it) before every commit and every install.
- **Installs are live.** `npm run install-extension` writes into `~/.pi-pocket/extensions/`, and a saved module reloads into the running server the whole team works in. Run `npm run install-check` first and make sure every file it lists is one you meant to change. If an installed file differs from the project's and you don't know why, stop and ask: someone may have edited the live copy.
- **Brian turns modules on and off, and restarts the server.** Never enable or disable an extension or restart the server; finish, test, and tell him what needs doing.
- **Tests stay isolated.** They use the Pi Pocket checkout's test harness (temporary data, test credentials, a fake model). Point modules at fixtures with environment variables (`PI_POCKET_TEAM_AGENTS`, `PI_POCKET_HOMEWIKI_ROOT`), never at Brian's real data.
- **Nothing secret in git.** `node_modules`, `_pocket.d.ts` and `_pocket` are links into the Pi Pocket checkout made by `npm run link` (`PI_POCKET_CHECKOUT`, default `../pi-pocket`), and stay ignored. Never commit anything from `~/.pi-pocket` or `~/.config/pi-pocket-team`, tokens, or credentials.
- **Stored data is forever.** Document kinds (`x.team.identity`, `x.team.memory`, `x.night-shift.goal`), task names (`x.night-shift.driver`), and their fields are stored in Brian's sessions: never rename a kind or change what a field means; add new ones beside them.
- **Night shift is restart-safe by design.** Round messages use stable request ids, the round count moves in the commit that starts the round, and the check sits behind a started memo. The wait before `start` is a restart-safe in-phase wait in the driver's `wait` phase (not `runtime.sleepUntil`: a stop must end it at once). `night-shift.test.ts` covers each rule (each stop reason, and a restart during the wait): keep it so when you touch the driver. Never make it pick a model or call a judge model.
- **Agent memory follows Pi Pocket's memory rules** (`src/server/memory.ts` in the checkout): Pi proposes, the owner approves, approvals check what the owner saw, and a replayed tool call never adds twice. Keep `team-memory.test.ts` covering each rule you touch.
- **Team reaches Night shift only through the global `Symbol.for("pi-pocket-team.night-shift")`, never by an import** (an import keeps a stale copy after a reload, and a second driver definition). `team-night-shift.test.ts` covers delegated goals: the goal, the report back, replay, the refusals, and the start wait.
- The homewiki's content belongs to Bellonda; this module only renders it.

## Releases and dependencies

- Tag format: none. This repository has no tags and no GitHub releases, and it needs none: nothing depends on a version of it.
- How a release starts: there are no releases. A change reaches the running server when Brian runs `npm run install-check`, then `npm run install-extension`, from a checkout of `main` (see "Installs are live" above). Agents never install unless Brian asks.
- Who tags: Brian. Agents never tag, push tags, or release.
- Version rule: none. `package.json` keeps `version` at `0.1.0`, and `private: true`: it is never published.
- Internal dependencies: the Pi Pocket checkout (bketelsen/pi-pocket, upstream TannerMidd/pi-pocket). `npm run link` links `node_modules`, `_pocket.d.ts` and `_pocket` into it (`PI_POCKET_CHECKOUT`, default `../pi-pocket`). There is no version pin in `package.json`. CI pins it in `.github/workflows/ci.yml` (`git clone --branch v0.25.0`): move that tag when the server moves to a new Pi Pocket release. `.github/workflows/upstream.yml` tests against upstream `main` each Monday and only warns. README.md names the oldest Pi Pocket release that works (v0.21.0).
- Who uses this repository: only Brian's running Pi Pocket server, through `~/.pi-pocket/extensions/`. No other repository depends on it.
