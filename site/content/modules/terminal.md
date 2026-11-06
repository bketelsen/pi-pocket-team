# Terminal

A "Terminal" rail page that opens a login shell as the server's user, in a folder you pick: Home, the folder of the session the tab shows, or an absolute path. Output goes to the tab by a long poll, so there is no websocket and no token in an address; input and resize are small POSTs.

Files: `terminal.ts` and `terminal-web/`, which draws the terminal with the vendored xterm.js. The design, with numbers and rules, is [docs/terminal.md](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/terminal.md).

## Use it

The owner turns the module on in **Menu → Extensions**, then opens **Terminal** in the rail. A tab opens in the folder you pick, and the shell starts as the server's user.

The page says it plainly: "Keys typed here go straight to a shell as the server's user. Lancet Guard and Pi do not see them." That is the point of it, and the rule: this is the server's own shell, not a guarded tool call.

A phone fits: a key bar with Esc, Tab, Ctrl (sticky), the arrows, Paste and Select. The shell keeps running while the page is closed, and the rail badge counts it.

## Owner only

Every route is the owner's, and each handler checks it too: guests, viewers and people invited to one session get a 404, and their tabs load no browser module.

## The shell and its environment

- The shell is `python3 -I -c <helper> <login shell> <folder> <rows> <cols>`, where the helper is a pty carried in `terminal.ts`. `PI_POCKET_TERMINAL_SHELL` replaces the login shell.
- The environment is an allowlist (`HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, `LANG`, `LC_*`, `TZ`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`) plus `TERM=xterm-256color` and `COLORTERM=truecolor`. Provider keys, tokens and Pi Pocket's own variables do not reach the shell.

## Limits

- **4 shells at once:** a 5th start is a 429, also when starts come at once.
- **Memory:** the last 256 K characters of each shell are kept in memory, and one poll carries up to 16 terminals.
- **Input:** at most 32 K characters a POST (413 above).
- **Keys are written once.** Each chunk carries the tab and that tab's sequence number, and the server writes only a number newer than the last one it took. A POST that failed on the way is sent again with the same chunk and the same number, after 0.5, 1, 2 and 4 s. After 60 s the tab gives up and says how many characters may not have reached the shell.
- **Back pressure is for each tab:** a shell pauses its output when the oldest tab still watching it is more than 128 K characters behind. A tab that has not polled for 30 s stops counting, and one shell keeps 16 tabs at most.
- **When a shell ends:** Close, when the shell exits (its code shows for 60 s), 60 s after the last output poll, 60 minutes after the last keystroke, or when the module goes. `PI_POCKET_TERMINAL_DETACH_MS` and `PI_POCKET_TERMINAL_IDLE_MS` lower those 2 spans.
- **Nothing is logged.** Keystrokes and output live in memory only; the server log gets a start failure, and nothing else.

## Read more

The reference page is [Terminal](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/terminal.md). The tests are `terminal.test.ts` for the server side, and `terminal-web.test.js` for the browser module.

## Polling and paste

- A poll carries what the tab received and what its screen drew, and back pressure follows the drawn offset: a tab that draws 64 K past the ack of its open poll starts it again, so a paused shell goes on at once.
- A resize goes 1 POST at a time, and a size that changed during one goes right after it.
- A 409 is a shell that exited: its keys and sizes stop, and the tab keeps polling until the answer with its last output and exit code comes. A 404, or a `gone` entry, ends the terminal.
- Paste goes through `term.paste()`, so a shell that asked for bracketed paste gets it, in the same queue as the keys.
