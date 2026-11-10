# Set up, test and install

The requirements, the setup of a checkout and its tests, and the install into a Pi Pocket server. The user site's
version is [Install into Pi Pocket](https://bketelsen.github.io/pi-pocket-team/getting-started/install/).

## Requirements

- Pi Pocket v0.21.0 or later (Pi Durable 1.4: `runtime.sleepUntil` and `checkpointWhen`). It includes the linked-session working directory (PR #112) that Team delegation needs.
- The modules declare `pocketApi = 2` (Pocket's extension API version). A Pocket with another API version may refuse them or break them.
- Node.js 24, the one Pocket runs on.
- A Pi Pocket checkout for the tests: `../pi-pocket-live` by default when it is a checkout, else `../pi-pocket`.

## Setup and test

Clone this repository next to a Pi Pocket checkout, or set `PI_POCKET_CHECKOUT` to the checkout's path. On a host where the server runs a release folder through the link `pi-pocket-live` (bketelsen/pi-pocket `BK-PATCHES.md`, step 6), the default is that link, so the tests run against the release the server runs; else it is `../pi-pocket`.

```sh
npm run link       # make node_modules, _pocket.d.ts, and _pocket point into the checkout
npm test           # node --test, plus node --check of the browser modules
npm run typecheck  # types of team.ts, homewiki.ts, night-shift.ts, desk.ts, and terminal.ts
npm run lint       # Prettier and ESLint, Pi Pocket's config (npm run format fixes)
make verify        # the template gate, then lint, tests, and type check (CI runs make ci)
```

`npm run link` also runs before `npm test`, `npm run typecheck`, and `npm run preview`. It creates or repairs 3 symlinks in the repository root: `node_modules` to the checkout's `node_modules`, `_pocket.d.ts` to its `types/pocket.d.ts`, and `_pocket` to the checkout itself, which the tests and `preview.ts` import through. The links name the checkout path as it is given: through `pi-pocket-live`, they follow the server to each new release folder. It never deletes a real file or folder.

The tests run each module inside a real Pi Pocket app built by the checkout's test harness: temporary data, test credentials, a fake model. `homewiki.test.ts` points the module at a fixture wiki with `PI_POCKET_HOMEWIKI_ROOT`; the server never sets it, so production reads the real checkout. `team-memory.test.ts` checks agent memory's rules directly and through the app, with fixture agent profiles. `night-shift.test.ts` runs shifts against a scripted model, restarts included, through `/team-shift` and its old name `/night-shift`. `shift-names.test.ts` reads the literals of the modules and the prose of the docs and the site (outside code), and fails on a text that still names the feature "night shift", except the stored names, identities, aliases and old-name notes on its lists. `npm run preview` (`preview.ts`) opens an isolated app with sample lessons, to look at the panel.

## Install into your Pi Pocket

```sh
npm run install-check      # list what an install would write; writes nothing
npm run install-extension  # copy changed files into ~/.pi-pocket/extensions/
```

The installer compares every file byte for byte and writes only those that differ, so installing unchanged source touches nothing. It never deletes: installed files the project doesn't have are listed and left alone. `install-extension` copies into `~/.pi-pocket/extensions/`, or `$PI_POCKET_DIR/extensions` when `PI_POCKET_DIR` (Pocket's data folder) selects another installation.

Each file is written to a temporary file beside it (`.team.ts.install-<pid>`: a dot name without the `.ts` ending, so Pocket's watchers ignore it), then renamed over the installed file. A module therefore reloads once, from the whole file: a direct copy left the file empty for a moment (on btrfs, for about a second while the reflink waited), and the server tried to load it empty. A link in the extensions folder is replaced by a file, not written through.

The server must already have `node_modules` in its extensions folder. Pocket's drop-in setup does this; see Pocket's `docs/extensions.md`. The installer only checks that the link resolves; it never makes or moves it. On a server that runs through `pi-pocket-live`, the links `node_modules` and `_pocket.d.ts` in the extensions folder point through it too (`~/projects/pi-pocket-live/node_modules` and `~/projects/pi-pocket-live/types/pocket.d.ts`), so they follow each switch with no change.

An install writes into the running server: a saved module reloads at once, and open tabs pick up browser changes. Installing never turns a module on or off and never restarts the server; the owner does both, in **Menu → Extensions**. Run `npm test` before every install.

To move the server, these drop-ins and the team to another machine and user, follow [docs/team-vm-cutover.md](team-vm-cutover.md).
