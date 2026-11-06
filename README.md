<!-- readme-kind: extension -->

# pi-pocket-team

pi-pocket-team is a set of drop-in extensions for [Pi Pocket](https://github.com/TannerMidd/pi-pocket), for the owner
of a server who works with a team of named agents. It is written for Brian Ketelsen's own server and shared as it is.

**Status:** in production. Its owner's server runs it, installed from `main`; there are no releases.

**Documentation:** [bketelsen.github.io/pi-pocket-team](https://bketelsen.github.io/pi-pocket-team/)

## What it does

- **Team.** Named agents in ordinary sessions, a supervisor that delegates into their repositories, and each agent's
  own memory. See [Team](https://bketelsen.github.io/pi-pocket-team/modules/team/).
- **Desk.** One thread for each piece of background work: its agents, PRs, asks and reports, on an owner-only page.
  See [Desk](https://bketelsen.github.io/pi-pocket-team/modules/desk/).
- **Night shift.** `/night-shift`: Pi works on an objective in rounds until a stop condition, a round limit or a
  deadline, then writes a summary. See [Night shift](https://bketelsen.github.io/pi-pocket-team/modules/night-shift/).
- **Model router.** Shadow only: it records the model it would pick for a delegated night shift, and changes nothing.
  See [Model router](https://bketelsen.github.io/pi-pocket-team/modules/model-router/).
- **Homewiki.** The "Wiki" rail page: a Markdown wiki checkout rendered from disk, read-only and owner-only. See
  [Homewiki](https://bketelsen.github.io/pi-pocket-team/modules/homewiki/).
- **Terminal.** The "Terminal" rail page: a login shell as the server's user, owner-only. See
  [Terminal](https://bketelsen.github.io/pi-pocket-team/modules/terminal/).
- **Daily audit and home seed.** Scripts that report on a day of the team's work, and make each agent's home folder.
  See [daily audit](docs/modules/daily-audit.md) and [home seed](docs/modules/home-seed.md).

## Requirements

Pi Pocket v0.21.0 or later (extension API 2), on Node.js 24, and a Pi Pocket checkout beside this repository
(`../pi-pocket` by default) for the links and the tests.

## Install

```sh
git clone https://github.com/bketelsen/pi-pocket-team.git
cd pi-pocket-team
npm run link               # link node_modules, _pocket.d.ts and _pocket to ../pi-pocket
npm run install-check      # list what an install would write; it writes nothing
npm run install-extension  # copy the changed files into ~/.pi-pocket/extensions/
```

Then the owner turns each module on in Menu → Extensions. An install reloads a saved module at once; it never turns a
module on or off, and never restarts the server. The full steps: [install](https://bketelsen.github.io/pi-pocket-team/getting-started/install/).

## Develop

```sh
mise install   # the pinned Node
npm run link   # the links to the Pi Pocket checkout
make ci        # what CI runs: the template gate, lint, tests, type check
make site      # the documentation site, in strict mode
```

The full guide: [docs/setup.md](docs/setup.md), and [build and test](https://bketelsen.github.io/pi-pocket-team/contributing/build/).

## Where to go next

- [AGENTS.md](AGENTS.md): the rules for agents and contributors.
- [docs/README.md](docs/README.md): the module reference, the designs, the plans and the decisions.
- [SECURITY.md](SECURITY.md): report a vulnerability privately.
- [LICENSE](LICENSE): MIT.
