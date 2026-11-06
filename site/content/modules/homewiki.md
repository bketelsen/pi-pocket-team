# Homewiki

The "Wiki" rail page shows a Markdown wiki checkout as it is on disk, uncommitted edits included. Brian's is `bketelsen/homewiki`, kept by his agent Bellonda. The page notes the checkout's commit and whether it has uncommitted edits.

Files: `homewiki.ts` and `homewiki-web/`. It is read-only and list-only: the module renders a folder, and it never writes one.

## What it shows

- **Pages:** `README.md` and every `.md` file under `docs/`, skipping hidden files and folders. `README.md` comes first; the rest sort by their `order` frontmatter (none sorts last), then by path. The title is the frontmatter `title`, else the first `#` heading, else the path. A subfolder of `docs/` becomes a section.
- **Live:** a watcher on the checkout tells open tabs when a Markdown file changes, at most once a second, so an edit shows without a reload.
- **The checkout:** the page notes the commit the folder is at, and whether it has uncommitted edits.

## Choose the folder

The folder comes from `PI_POCKET_HOMEWIKI_ROOT`, default `~/projects/homewiki`. The server process environment must have the variable when you want another folder, and a change needs a server restart.

## Turn it on

Like every module it starts off. The owner turns the module on in **Menu → Extensions**, and the owner restarts the server. Before that, install the files ([Install into Pi Pocket](../getting-started/install.md)).

## Routes

Both routes are owner-only:

- `GET /api/x/homewiki/pages` returns the list of pages.
- `GET /api/x/homewiki/page?path=…` serves a page only when `path` is exactly one in that list, with its frontmatter stripped.

Anything else is a 404: `../`, absolute paths, `.git/config`, and files outside `docs/`. The module only ever reads a path it listed itself.

## Limits

- The wiki's content belongs to its owner. This module only renders it; it does not edit, create or commit a page.
- It reads nothing but the `README.md` and `docs/**/*.md` of the checkout.
- To read another wiki, point `PI_POCKET_HOMEWIKI_ROOT` at its folder and restart the server.

## Read more

The README section is [Homewiki](https://github.com/bketelsen/pi-pocket-team#homewiki).

## Tests

`homewiki.test.ts` points the module at a fixture wiki with `PI_POCKET_HOMEWIKI_ROOT`. The test harness sets it; the server never sets it, so production reads the real checkout.
