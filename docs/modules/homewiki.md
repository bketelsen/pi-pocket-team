# Homewiki

The "Wiki" rail page shows a Markdown wiki checkout as it is on disk, uncommitted edits included. Brian's is `bketelsen/homewiki`, kept by his agent Bellonda. The page notes the checkout's commit and whether it has uncommitted edits.

The folder comes from `PI_POCKET_HOMEWIKI_ROOT`, default `~/projects/homewiki`. The server process environment must have the variable when you want another folder, and a change needs a server restart.

- **Pages:** `README.md` and every `.md` file under `docs/`, skipping hidden files and folders. `README.md` comes first; the rest sort by their `order` frontmatter (none sorts last), then by path. The title is the frontmatter `title`, else the first `#` heading, else the path. A subfolder of `docs/` becomes a section.
- **Read-only, list-only:** `GET /api/x/homewiki/pages` returns the list; `GET /api/x/homewiki/page?path=…` serves a page only when `path` is exactly one in that list, with its frontmatter stripped. Anything else (`../`, absolute paths, `.git/config`, files outside `docs/`) is a 404. Both routes are owner-only.
- **Links:** a relative link to a wiki page opens that page in the Wiki page. The link's file and `#` fragment are split before they are decoded, and a malformed percent escape (`50%.md`) stays as it is written. A link to a file that is not a page shows "No wiki page at" and the path.
- **Live:** a watcher on the checkout tells open tabs when a Markdown file changes, at most once a second, so edits show without a reload.

The wiki's content belongs to its owner; this module only renders it.
