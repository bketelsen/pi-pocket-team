# Install into Pi Pocket

The modules are source files in this repository. They run inside your own Pi Pocket server: an install copies the changed files into the server's extensions folder. This page names the requirements, then the 3 commands that set up a checkout and install the modules.

## Requirements

- Pi Pocket v0.21.0 or later (Pi Durable 1.4: `runtime.sleepUntil` and `checkpointWhen`). It includes the linked-session working directory that Team delegation needs.
- The modules declare `pocketApi = 2`, Pi Pocket's extension API version. A Pocket with another API version may refuse them or break them.
- Node.js 24, the one Pocket runs on.
- A Pi Pocket checkout for the tests, `../pi-pocket` by default. Set `PI_POCKET_CHECKOUT` to another path.

The same list, with the reasons, is in [Requirements](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/setup.md#requirements).

## Set up a checkout

Clone this repository next to a Pi Pocket checkout, or point `PI_POCKET_CHECKOUT` at one.

```sh
npm run link       # make node_modules, _pocket.d.ts, and _pocket point into the checkout
make verify        # the template gate, then lint, tests, and type check
```

`npm run link` creates or repairs 3 symlinks in the repository root: `node_modules` to the checkout's `node_modules`, `_pocket.d.ts` to its `types/pocket.d.ts`, and `_pocket` to the checkout itself, which the tests and `preview.ts` import through. It never deletes a real file or folder, and it also runs before `npm test`, `npm run typecheck` and `npm run preview`.

`make verify` runs the template gate, then `npm run lint`, `npm test` and `npm run typecheck`. It needs Node.js 22 or later. [Build and test](../contributing/build.md) covers the checks in full.

## Install the modules

```sh
npm run install-check      # list what an install would write; writes nothing
npm run install-extension  # copy changed files into ~/.pi-pocket/extensions/
```

The installer compares every file byte for byte and writes only those that differ, so installing unchanged source touches nothing. It never deletes: installed files the project does not have are listed and left alone. `install-extension` copies into `~/.pi-pocket/extensions/`, or `$PI_POCKET_DIR/extensions` when `PI_POCKET_DIR` selects another Pocket data folder.

Run `npm run install-check` first, and make sure every file it lists is one you meant to change.

!!! note "The server needs `node_modules`"

    The extensions folder must already have `node_modules` in it. Pocket's drop-in setup does this; see Pocket's `docs/extensions.md`.

## Turn a module on

An install writes into the running server: a saved module reloads at once, and open tabs pick up browser changes. Installing never turns a module on or off and never restarts the server.

The owner turns each module on in **Menu → Extensions**, and the owner restarts the server. A new module starts off. Installing the files does not enable it.

!!! warning "Run the tests before every install"

    `npm test` runs each module inside a real Pi Pocket app built by the checkout's test harness: temporary data, test credentials, a fake model. It never reads a real server's data.

## Next

- [Team](../modules/team.md) is the module to turn on first: the Desk and shifts read its identities and its roster.
- [Build and test](../contributing/build.md) names every check the repository runs.
