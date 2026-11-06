# Security policy

These drop-ins run inside Brian's Pi Pocket server, with the rights of the server's user. The Terminal module gives the owner a login shell on that machine. The Desk, Team, Homewiki and Terminal routes are owner-only. A bug in an owner check or in a path check is therefore a security bug, not a feature bug.

## Supported versions

Only the `main` branch gets fixes. This repository has no releases and no tags.

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open https://github.com/bketelsen/pi-pocket-team/security and press **Report a vulnerability**. Do not open a public issue with the details. Do not post tokens, session data, or logs from `~/.pi-pocket`.

## What to include

The commit, the module, the route or file, the impact, and the steps to reproduce.
