# Build and test

This page names the checks the repository runs, how the tests stay isolated, and how to build this site. Install first: [Install into Pi Pocket](../getting-started/install.md).

## Set up a checkout

Clone the repository next to a Pi Pocket checkout, or set `PI_POCKET_CHECKOUT` to the checkout's path, then link the 3 paths the tests import through.

```sh
npm run link   # make node_modules, _pocket.d.ts, and _pocket point into the checkout
```

## The checks

```sh
make verify                  # the non-mutating gate
make ci BASE=origin/main     # the gate CI runs
```

`make verify` runs the template gate (`node scripts/check-template.mjs`), then `npm run lint`, `npm test` and `npm run typecheck`. It changes no file. A single step also runs alone:

```sh
npm test           # node --test (the template gate's tests too), plus node --check of the browser modules
npm run typecheck  # the types of the modules
npm run lint       # Prettier and ESLint, Pi Pocket's config (npm run format fixes)
```

`make ci` runs the same gate, and with `BASE` set it also checks that `.memory/corrections.jsonl` is append-only against the PR base. CI job `Test` runs `make ci`, and its name is the required check.

Node is pinned in `mise.toml` and `mise.lock`; `make verify` needs Node.js 22 or later.

## How the tests stay isolated

The tests run each module inside a real Pi Pocket app built by the checkout's test harness: temporary data, test credentials, a fake model. `homewiki.test.ts` points the module at a fixture wiki with `PI_POCKET_HOMEWIKI_ROOT`, and the server never sets it, so production reads the real checkout.

- `team-memory.test.ts` checks agent memory's rules directly and through the app, with fixture agent profiles.
- `night-shift.test.ts` runs shifts against a scripted model, restarts included, through `/team-shift` and its old name `/night-shift`.
- `shift-names.test.ts` fails on a literal in the modules, or prose in the docs and the site (outside code), that still names the feature "night shift", except the stored names, identities, aliases and old-name notes on its lists.
- `npm run preview` (`preview.ts`) opens an isolated app with sample lessons, to look at the panel.

## Build this site

The site is built with ProperDocs and the MaterialX theme, from the pages in `site/content/` and the settings in `site/properdocs.yml`.

```sh
make site        # strict build into site/dist
make site-serve  # preview at http://127.0.0.1:8000/pi-pocket-team/
```

The site needs the Python lock in `site/requirements.txt` and writes its virtual environment to `build/site-venv`. `make ci` does not build the site: a change that does not touch `site/` needs no Python toolchain. Strict mode fails the build on a broken relative link or a missing anchor.

## What stays with the owner

Installs and server restarts are the owner's: `npm run install-check` first, then `npm run install-extension`, and the owner turns a module on or off and restarts the server in **Menu → Extensions**. Run the tests before every install.

## Read more

The reference sections are [Setup and test](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/setup.md#setup-and-test) and [Install into your Pi Pocket](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/setup.md#install-into-your-pi-pocket). The repository's own rules for a change, with the docs, the risk paths and the corrections, are in `AGENTS.md`.
