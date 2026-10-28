# Terminal: design

A drop-in "Terminal" rail page (and phone home-screen button) that opens an interactive login shell as the server's
user (`team`) in a chosen folder. xterm.js draws it in the browser; a pseudo-terminal (pty) runs it on the server.
Files: `terminal.ts` (server) and `terminal-web/` (browser module, with xterm.js vendored in `terminal-web/vendor/`).

## Answers to the open questions

**Can a drop-in hold a websocket or a streaming route?** No websocket: `web.route` answers JSON only, and a drop-in
has no upgrade hook. It does not need one. A route has no time limit (`docs/extensions/routes.md`, "Time"), so output
uses a **long poll**: `GET poll?tab=<tab>&t=<id>.<from>.<ack>,…` answers at once when any named terminal has output
past its `from`, has exited, or is gone, else waits up to 25 s. `from` is the offset the tab has received, and the
answer starts there; `ack` is the offset xterm has drawn. `id.from` alone is taken as `ack` = `from`, and a tab draws
no more than it received (else a 400). It carries every terminal of the tab, 16 at most, in one answer:
`{ terminals: { <id>: { data, from, to, exited?, exitCode? } | { gone: true } } }`. It holds an entry for each terminal
that has something, and at the 25 s end an empty one for each live terminal, so a tab keeps its offsets. A poll names
16 terminals at most: the 4 live ones, plus exited ones that still need their last output. Input and resize are small
`POST`s. Every request goes through the app's own sign-in and `X-Pocket` check. Events (`web.send`) are
not used for output: they go to every tab of the person, are capped at 100 events and 1 MB a second for the module, and
drop the rest. Events carry only the list of terminals (for the rail badge).

**Why 1 poll for each tab, not 1 for each terminal?** A browser gives a host 6 connections over HTTP/1.1, and every tab
of the app shares them. The live server is HTTP/1.1. A poll for each terminal would hold 1 connection for each shell:
4 shells in 2 tabs would take all 6, and no other request of the app would get through. So the tab holds 1 poll, and it
carries every terminal the tab shows. The poll starts again, with the new set, when a terminal is attached, ended, or
closed; with no terminal it does not poll. Each rule stays for each terminal: the polls that keep a shell from the
detach timer, the back pressure of its buffer, and 256 K characters at most for it in one answer.

**Back pressure is for each tab, by what it has drawn.** The tab sends an id of its own, `<tab>`: 1 to 64 letters,
digits, and dashes, made once when the module sets up. Each shell keeps, for each tab, the `ack` that tab last sent and
when it last polled (at most 16 tabs, and one that has not polled for 30 s is dropped: a poll waits 25 s). The shell's
output pauses when the oldest tab that still watches has drawn more than KEEP / 2 characters less than the shell has
written, and it resumes when that tab catches up, so the shell writes only as fast as the slowest tab that reads it.
Only an `ack` counts: receiving an answer acknowledges nothing. With no tab that watches, the highest offset any
request asked for is the measure, and the detach timer ends that shell anyway. So what a tab has received but not
drawn stays about KEEP / 2 + 64 K, far under what xterm holds well. With no tab that watches, the highest offset any request asked for is
the measure, and the detach timer ends that shell anyway.

**No upstream change is needed.** The page, routes, rail button, `pocket.style`, and `escape: false` / `swipe:
false` on the page are all in the v0.25 extension API.

**Which pty?** A small Python 3 helper over stdin/stdout, embedded in `terminal.ts` as a string and run as
`python3 -I -c <helper> <shell> <folder> <rows> <cols>`. It uses the standard `pty` module, so it needs no native
build and no package.

- `node-pty` is out. The VM has a toolchain (`gcc`, `make`, `python3`), but node-pty has no Linux prebuilt, and a
  drop-in has no package folder of its own: `~/.pi-pocket/extensions/node_modules` is a link to Pi Pocket's
  packages. Installing node-pty there is a local patch to Pi Pocket, which Sheeana's rules forbid.
- `script -qc bash /dev/null` gives a pty but cannot resize it.
- The helper was tried on the VM (Snow Linux 13, Python 3.13.5, Node 24.22.1): output, UTF-8, resize (`stty size`
  follows), the exit code, `SIGPIPE` reset for the shell (`yes | head` exits 141), and closing stdin ends the shell
  and its foreground job. When the pty gives EOF first (a shell that closed its own fds and runs on), the helper keeps
  reading stdin, every 0.2 s, so a closed stdin still ends that shell; it exits with the status it reaped.

Helper protocol: stdout carries the pty's raw output bytes. stdin carries frames: 1 byte kind, 4 bytes length (big
endian), the body. Kind `d` is input bytes. Kind `r` is a resize: rows and columns as 2 unsigned 16-bit numbers. When
stdin closes (the terminal ends, the module reloads, or the server process dies), the helper sends `SIGHUP` to the
shell's process group, then `SIGKILL` after 2 s, and exits. When the shell exits, the helper exits with its code.

## Lifecycle

- **Start:** `POST terminals` with a folder: `home` (the default, `os.homedir()`), `session` with a conversation
  id (its `cwd`, checked against `request.sessions()`), or an absolute path to an existing folder. The shell is the
  user's login shell (`os.userInfo().shell`, run as a login shell, `-bash`).
- **Environment:** only an allowlist from the server's environment (`HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`,
  `LANG`, `LC_*`, `TZ`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`), plus `TERM=xterm-256color` and
  `COLORTERM=truecolor`. Provider keys, tokens, and Pi Pocket's own variables in the server's environment do not pass
  to the shell. The login shell reads the user's own profile.
- **Cap:** 4 terminals at once. A 5th start answers 429.
- **Output buffer:** the last 256 K characters of output, in memory only, so a tab that reloads gets the screen
  back. When the oldest tab that still watches a shell is more than 128 K (KEEP / 2) characters behind, the server
  pauses the helper's stdout. The pipe then fills, and the shell's writes block, as on a slow real terminal. So a
  following tab loses no output, and a slow tab never falls behind the buffer.
- **Input is written once.** Each tab numbers its chunks of keys: `POST terminals/:id/input` carries `{ data, tab,
seq }`, and the server keeps, for each tab of a terminal, the last `seq` it wrote, for RECEIPT_MS (10 minutes) after
  its last write. `PI_POCKET_TERMINAL_RECEIPT_MS` sets that span, as the detach and idle spans are set. A `seq` that is
  not newer than the last one is answered `{}` and writes nothing, so a tab may send the same chunk again after a POST
  that failed on the way. `tab` is 1 to 64 letters, digits, and dashes, and `seq` a positive whole number; a missing
  one is a 400. 16 tabs may type into one terminal at once: a 17th is answered 429, and writes nothing, until one of
  them has been quiet for RECEIPT_MS. Receipts are never dropped for their number: that is what keeps a repeated `seq`
  from writing twice. The browser keeps the chunk until the server has it, and tries it again after 0.5, 1, 2, and 4
  s, then every 4 s, with a note that reads "Input waits for the server…". It tries a chunk for 60 s in all, and the deadline also aborts a request in flight
  (`deliver()`), so a request that never settles cannot hold the chunk longer. After that, the chunk is never sent again by itself, the page says how many characters may not have reached the shell, and
  its **Discard** button drops them, after which typing goes on with the next `seq`. 60 s is far less than
  RECEIPT_MS, so a retry never meets a receipt the server has forgotten.
- **A 409 is a shell that exited.** On a key or a size, a 404 means the terminal is gone: the tab stops and says so.
  A 409 means the shell exited: the tab stops its keys and its sizes for that terminal, and keeps polling it until an
  answer brings its last output and its exit code.
- **The tab says what it has received, and what its screen has drawn.** The poll's `from` is the received offset, and
  the loop asks again as soon as an answer is in; the text goes to xterm with a callback that moves `drawn`, the
  poll's `ack`. The server's back pressure follows `ack`, so what waits undrawn stays small. When xterm draws more
  than 64 K past the `ack` of the open poll, the tab starts that poll again, so a paused shell goes on at once instead
  of waiting out its 25 s. A write that fails ends that terminal's poll with a note, and the tab's poll starts again
  for the others.
- **A size is sent when it changes, 1 `POST` at a time.** The wanted size and the size the server has are kept apart;
  a size that changed while a `POST` was in flight goes right after it, and a failed `POST` is tried again with the
  same bounded waits. A 404 or a 409 ends the terminal.
- **End:** the shell exits; the tab presses Close (`DELETE terminals/:id`); no tab polls for 60 s (the tab closed);
  no keystroke for 60 minutes (idle); the module reloads, is turned off, or the server restarts (`web.onDispose`
  closes every helper's stdin, and a dead server process closes the pipes too).
- **Reconnect:** after a tab reload or a network drop, yes, within 60 s: the page lists the live terminals, attaches
  again, and replays the buffer. After a server restart or a module reload, no: the shells are gone, and the page says
  so (the poll answers `gone` for each one). (Keeping shells across a reload would need hidden global state that outlives the module's code; not worth it.)
- **More than one tab** can show the same terminal. Each tab polls with its own `from`, `ack`, and id.

## Security

- **Owner only.** `web.client` and every route use `access: "owner"` (the default), and each route also checks
  `user.role === "owner"`. Guests, viewers, and people invited to one session get a 404 from every route, and the
  browser module never loads in their tabs. Tests cover each role.
- **Same sign-in.** No new port, no websocket, no token in a URL: only the app's own authenticated `/api/x/terminal/`
  routes, which need the `X-Pocket` header.
- **Lancet Guard does not see it.** Keystrokes go straight to the shell: no guard, no approval, and Pi does not see
  them. The page says so in a line above the terminal.
- **No logging of keystrokes or output.** They pass through memory only. The output buffer is freed when the terminal
  ends. The server log gets nothing from this module except a start failure.
- **Same rights as Pi's `bash` tool** (the `team` user), without the guard. Not root.

## Browser

- A page (`escape: false`, so Esc goes to vim; `swipe: false`, so a swipe does not go back) with a tab strip of
  open terminals, a New button with the folder choice (Home, This session's folder when a session is open, or a
  path), and Close.
- xterm.js 6.0.0 and its fit add-on 0.11.0, vendored (`terminal-web/vendor/`, MIT, with their license) because the
  app's CSP allows scripts only from `'self'`. The fit add-on follows the page's size; each change sends a resize.
- The poll loop belongs to the browser module, not the page: closing the page to read a session keeps the shell; the
  rail badge counts the open terminals. It is 1 poll for the tab, which carries every terminal the tab shows.
- **Phone:** a key bar with Esc, Tab, Ctrl (sticky, for the next key), the arrows, Paste and Select. Paste uses
  `navigator.clipboard.readText()` when the browser allows it, else a text box to paste into and send. Both go through
  `term.paste()`, so a shell that asked for bracketed paste gets it, and the text takes its turn in the same queue as
  the keys. Select shows the screen's text in a plain text box, where the phone's own selection and copy work.
- Input goes in order: one `POST` at a time, with the keys typed meanwhile batched into the next one, 32 K
  characters at most per request.
- **A terminal that ended is fetched once.** The page lists every terminal, ended ones too, and a tab that attaches to
  one polls it once more: the buffer and the exit code arrive together, and then that terminal is done. A `terminals`
  event that says a terminal ended marks it so, and the next poll brings its last output and its exit code.
