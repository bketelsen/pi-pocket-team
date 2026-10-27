# Team VM: Pi Pocket cut-over runbook

Sheeana, 2026-10-27 (T331). This runbook moves Brian's Pi Pocket server, its drop-ins and the team's homes from
framework (user `bjk`) to the team VM on minideb (user `team`). It applies Brian's decisions of 2026-10-27 (thread
T322a; studies in `~/projects/odrade/reports/2026-10-27-team-vm/` and `…/2026-10-27-agent-homes/`).

Nobody runs this runbook until Brian says so. A step marked **Brian:** needs Brian himself (a sign-in, a secret, a
console, or a choice). Every other step runs as the `team` user on the VM, unless it says "on framework".

## Rules

- **One server only.** Never run Pocket on framework and on the VM at the same time, not even to read old sessions.
  Both copies hold the same durable tasks: 11 schedules, the desk sweeper and digest, night-shift drivers. Two
  servers would run each one twice against GitHub, and a provider's OAuth refresh on one server can sign out the
  other. Stop one server before you start the other, every time (cut-over, checks, rollback).
- **Same Pocket version on both sides.** A Pocket release can upgrade the database one way (0.21.0 did). Copy the data
  folder only between 2 checkouts on the same tag.
- **New paths.** The VM has no `/var/home/bjk` and no symlink to it. Configuration that names
  `/var/home/bjk` is rewritten (step 6). The database is never edited.
- **Old sessions are read-only history.** They move with the database, but their folders do not exist on the VM.
  Brian archives them after the cut-over (step 9) and reads them there. Nobody sends a message in an old session,
  except the 2 sessions in step 8 (Odrade's supervisor session and the Clerk).
- **No secret in a command line, a file in git, or a report.** The commands below name secrets by path only.
- **Headless** (Brian, T330a: no auto-login). The VM has no graphical login, so nothing may need a desktop session or
  the GNOME keyring. Pocket runs as a system unit (user `team`, linger on). The browser tool runs Chromium headless
  (Pocket starts it with `--headless=new`; no display). gh keeps its token in a file, `~/.config/gh/hosts.yml`
  (mode `0600`), not in a keyring. Agents reach hosts with key files named in `~/.ssh/config`; `SSH_AUTH_SOCK` is
  unset, or a plain `ssh-agent`, and never `/run/user/*/keyring/ssh`.

## Names used here

| Name      | Value                                                                                                              | Who sets it                         |
| --------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `VM`      | the team VM's host name (for example `team-vm`)                                                                    | Teg, fleet (`tofu/minideb`)         |
| `VM_IP`   | its LAN address, a UDM DHCP reservation on `br0`                                                                   | **Brian:** UDM reservation          |
| `TS_NAME` | its Tailscale node (for example `pocket`); Pocket at `https://pocket.goat-snake.ts.net`                            | **Brian:** Tailscale sign-in        |
| team user | `team`, home `/var/home/team`                                                                                      | Teg, fleet (Firn recipe or Ansible) |
| `TAG`     | the Pocket release framework runs at the cut-over: `git -C ~/projects/pi-pocket describe --tags` (`v0.25.0` today) | framework                           |
| `DATE`    | the cut-over date, `YYYY-MM-DD`                                                                                    |                                     |

Replace them where they appear. When Teg's fleet PRs choose other names, those win.

## Layout on the VM

```
/var/home/team/
  .pi-pocket/                  Pocket's data folder (copied from framework)
  .pi/agent/                   Pi's config: AGENTS.md, skills, prompts, mcp.json, models, sign-ins (copied)
  .config/pi-pocket-team/      agent profiles and desk.json (copied, then rewritten)
  .config/gh/, .gitconfig      frostyard-machines, made fresh on the VM (never copied)
  .ssh/                        the team keys, 1 for each host (Teg)
  .local/bin/truenas-mcp       the truenas MCP server binary
  projects/                    fresh clones: pi-pocket, pi-pocket-team, homewiki, truenas-mcp, every profile repository
  agents/<id>/                 the agents' homes (local git, no remote)
  agents/odrade/               Odrade's desk (copied from framework ~/projects/odrade; it has no remote)
```

## 0. Hand-over from Teg (before this runbook)

Teg's fleet work ends when these hold. Check each one; stop if one fails.

```sh
ssh team@VM_IP true                      # the team user can ssh
gh api user -q .login                    # prints frostyard-machines
git config --global user.name            # the machine identity
id -nG | tr ' ' '\n' | grep -x kvm       # nsl machines need /dev/kvm
loginctl show-user team -p Linger        # Linger=yes
gh auth status 2>&1 | grep -ci keyring   # 0: the token is not in a keyring
grep -c oauth_token ~/.config/gh/hosts.yml   # 1: the token is in the file (prints a count, not the token)
stat -c %a ~/.config/gh/hosts.yml ~/.ssh/id_* # 600 for each
echo "${SSH_AUTH_SOCK:-unset}"           # unset, or a plain ssh-agent socket; never /run/user/*/keyring/ssh
ssh -G <host> | grep -i '^identityfile'  # for each host Teg keyed: the team key file for that host
```

Brian's steps in Teg's part, for reference: the UDM DHCP reservation, MokManager on the VGA console
(`incus console VM --type=vga`) once, and `gh auth login --insecure-storage` as frostyard-machines (device flow; the
flag keeps the token in `~/.config/gh/hosts.yml`, because the VM has no keyring). Teg's runbook owns them. The team ssh
keys have no passphrase: after a reboot nobody is there to unlock them. Their file mode and the VM protect them.

## 1. Prepare the VM (no Pocket data yet; framework keeps running)

1. **Tools in the team user's home** (Snow's `/usr` is read-only). Skip what Teg's role installed.

    ```sh
    curl -fsSL https://mise.run | sh                     # ~/.local/bin/mise, unless Homebrew's mise is on PATH
    mise use -g node@24 gh@latest                        # Node 24.22.1 or newer: the launcher warns below that
    node -v; gh --version
    ```

    The `~/.gitconfig` (Teg) must have the machine identity, `gh auth git-credential` for github.com
    (`gh auth setup-git`), and `url."https://github.com/".insteadOf git@github.com:`. framework's
    `~/.config/pi-pocket-agents/gitconfig` shows the same 3 settings; copy the values, not the file (it includes Brian's
    own `~/.gitconfig`).

2. **Checkouts.** Clone Pocket at the same tag, the drop-ins, the homewiki, and the truenas MCP:

    ```sh
    mkdir -p ~/projects && cd ~/projects
    gh repo clone TannerMidd/pi-pocket && git -C pi-pocket checkout TAG && (cd pi-pocket && npm install)
    gh repo clone bketelsen/pi-pocket-team && (cd pi-pocket-team && npm run link && npm test)
    gh repo clone bketelsen/homewiki
    gh repo clone bketelsen/truenas-mcp
    ```

    Pocket's checkout must stay owned by `team` and on an upstream tag: then Menu → **Update Pi Pocket** works.
    Add Brian's fork as a remote too (`git -C pi-pocket remote add bketelsen https://github.com/bketelsen/pi-pocket`),
    as on framework.

3. **Every profile repository.** Clone each repository that a profile names, at the folder the rewritten profile
   will name (`~/projects/<same relative path as on framework>`). On framework, this lists them:

    ```sh
    # on framework: name and folder of each roster repository, with the new home
    awk '/^repositories:/{r=1;next} /^[^ ]/{r=0} r && /^  [^ ]+: /{sub(/:$/, "", $1); print $1, $2}' \
      ~/.config/pi-pocket-team/agents/*.md | sed 's#/var/home/bjk/#~/#'
    ```

    On the VM, run `gh repo clone <name> <folder>` for each line, then `npm install` (or the repository's own setup)
    where the repository's AGENTS.md asks for it. Do not copy framework's checkouts: 431 GiB, mostly build output.

4. **The truenas MCP server.** Build the binary: `cd ~/projects/truenas-mcp && mise install && make build` (Go from
   `go.mod`), then copy `build/truenas-mcp` to `~/.local/bin/truenas-mcp`. Then:

    **Brian:** create the TrueNAS user and its role-bound API key in the TrueNAS UI (Teg's NAS step names the role).
    Write `~/projects/truenas-mcp/.envrc` (git ignores it; mode `0600`) with `TRUENAS_HOST` and `TRUENAS_API_KEY`
    for that key. `~/.pi/agent/mcp.json` reads it from there, by the same path as on framework, so its entry needs no
    change. Never paste the key in a chat or a command line.

5. **The browser tool.** Install Playwright's Chromium for the team user (Snow carries its libraries):

    ```sh
    cd ~/projects/pi-pocket && npx playwright install chromium
    ls ~/.cache/ms-playwright/                         # chromium-* and chromium_headless_shell-*
    ```

6. **Tailscale.** **Brian:** sign the VM in to the tailnet once (`sudo tailscale up`, or an auth key), with the node
   name `TS_NAME`. Then let the team user run Serve, and check that HTTPS certificates are on in the tailnet:

    ```sh
    sudo tailscale set --operator=team
    tailscale status | head -3
    ```

7. **The systemd unit** (a system unit, run as `team`; it starts at boot with no login). Copy Pocket's template
   and edit the copy (docs/systemd.md, "run as an existing user"):

    ```sh
    sudo cp ~/projects/pi-pocket/contrib/systemd/pi-pocket@.service /etc/systemd/system/
    sudoedit /etc/systemd/system/pi-pocket@.service
    ```

    Set these lines; leave the others as shipped. `NODE` is the absolute folder of `mise which node` (for example
    `/var/home/team/.local/share/mise/installs/node/24.22.1/bin`): a service does not see mise's shell setup.

    ```ini
    User=team
    Group=team
    Environment=POCKET_HOME=/var/home/team/projects/pi-pocket
    Environment=HOME=/var/home/team
    Environment=PATH=NODE:/var/home/team/.local/share/mise/shims:/var/home/team/.local/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin
    WorkingDirectory=/var/home/team/agents
    ExecStart=NODE/node ${POCKET_HOME}/bin/pi-pocket.js --access %i --port 8787 --data /var/home/team/.pi-pocket --cwd /var/home/team/agents
    UnsetEnvironment=SSH_AUTH_SOCK DISPLAY WAYLAND_DISPLAY
    # remove: StateDirectory=pi-pocket and StateDirectoryMode=0700 (the data folder is not /var/lib/pi-pocket)
    ```

    The unit runs with no login and no desktop: ssh uses the key files in `~/.ssh/config`, gh the token file, and the
    browser tool Chromium headless. Linger (Teg) keeps the team user's own systemd manager running for nsl machines.

    Keep `NoNewPrivileges=yes` (agents need no sudo on the VM) and `PrivateTmp=yes`. If nsl machines fail under the
    unit (systemd-vmspawn), remove `NoNewPrivileges` first and say so in the cut-over report. When Node's version
    changes, edit `NODE` and run `sudo systemctl daemon-reload`.

    ```sh
    sudo systemctl daemon-reload            # do not enable or start it yet
    ```

8. **Snapshot.** Teg or **Brian:** on minideb, `incus snapshot create VM pre-cutover-DATE`.

## 2. Drain framework (the quiet window)

Pick a day-time window, outside the night shift and outside the VM's reboot window (07:00-08:00 local). Odrade
pauses new delegations and night shifts.

1. **Running now must be empty.** No running tool call, generation, subagent, background task or night shift. On
   framework, this script reads the database read-only (the server may run):

    ```sh
    cat > /tmp/pocket-tasks.mjs <<'EOF'
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(`${process.env.HOME}/.pi-pocket/pocket.sqlite`, { readOnly: true });
    console.table(db.prepare("select kind, status, count(*) n from tasks where status <> 'terminal' group by 1, 2").all());
    console.table(db.prepare("select conversation_id session, count(*) n from tasks where kind = '\"pocket.schedule\"' and status = 'sleeping' group by 1").all());
    EOF
    node /tmp/pocket-tasks.mjs
    ```

    In the first table, only these may stay: `pocket.schedule` and `x.desk.sweeper` sleeping, and the tasks of the
    session that runs the cut-over. A `x.night-shift.driver` must be done. Wait, or stop the rest in the app.

2. **Unmerged work.** Each worktree with changed files or unpushed commits is pushed (a branch and a PR) or named in
   the report. On framework, read-only:

    ```sh
    for top in ~/projects/*/ ~/projects/frostyard/*/; do
      git -C "$top" rev-parse --git-dir >/dev/null 2>&1 || continue
      git -C "$top" worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r w; do
        d=$(git -C "$w" status --porcelain | wc -l); a=$(git -C "$w" rev-list --count @{u}..HEAD 2>/dev/null || echo "?")
        [ "$d" = 0 ] && [ "$a" = 0 ] || echo "$w changed=$d ahead=$a"
      done
    done
    ```

    `ahead=?` means a branch with no upstream: push it, or say why it can go.

3. **Schedules.** The second table of the script lists the sessions with sleeping schedules (11 in 6 sessions on
   2026-10-27). Each schedule is re-made on the VM (step 8), with new paths. In each listed session, ask Pi for `schedule list`, and copy the id, the time rule and the full text into
   `~/agents/odrade/plans/schedules-DATE.md` (Odrade's desk, on framework at `~/projects/odrade/plans/`). Then cancel
   each one there (`schedule cancel`). A schedule left sleeping would fire on the VM in an old session whose folder is
   gone.

4. **The desk.** Every open thread has its work on GitHub (a PR or an issue), or it is closed. A thread whose worktree
   is gone on the VM shows "git status failed" and stays open: Odrade closes or re-delegates those after the
   cut-over (step 9).

5. **Odrade's desk folder.** Commit it (`git -C ~/projects/odrade status` is clean).

## 3. Stop framework and back it up

```sh
# on framework
# stop Pocket: q in the pocket-start terminal (or Ctrl+C), then:
ls ~/.pi-pocket/harness.lock* 2>/dev/null && echo "STILL RUNNING: stop" || echo stopped
cp -a ~/.pi-pocket ~/.pi-pocket.backup-DATE
```

From here, framework's `~/.pi-pocket` must not start again unless the rollback says so.

## 4. Copy to the VM

**Brian:** run these on framework, with an ssh login as `team@VM_IP` (his own key, for the copy only). They copy
4 folders. They never copy Brian's `~/.ssh`, `~/.config/gh`, `~/.config/gh-machines`, `~/.config/pi-pocket-agents`,
`~/.pi/agent/sessions` (Pi CLI only), or `harness.lock*`.

```sh
rsync -a --exclude 'harness.lock*' ~/.pi-pocket/ team@VM_IP:.pi-pocket/
rsync -a --exclude sessions/ ~/.pi/agent/ team@VM_IP:.pi/agent/
rsync -a ~/.config/pi-pocket-team/ team@VM_IP:.config/pi-pocket-team/
rsync -a ~/projects/odrade/ team@VM_IP:agents/odrade/
```

On the VM, check the database copy before anything opens it:

```sh
node -e 'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(process.env.HOME+"/.pi-pocket/pocket.sqlite",{readOnly:true}); console.log(db.prepare("pragma integrity_check").get())'   # ok
ls -l ~/.pi-pocket ~/.pi/agent | head -40                            # owned by team
```

## 5. Re-make the links

The copied drop-in folder links to framework's checkout. Point it at the VM's:

```sh
cd ~/.pi-pocket/extensions
ln -sfn ~/projects/pi-pocket/node_modules node_modules
ln -sfn ~/projects/pi-pocket/types/pocket.d.ts _pocket.d.ts
cd ~/projects/pi-pocket-team && npm run install-check     # lists nothing when the copy equals main
```

Install no new drop-in version yet: the first start runs the same code as framework did (step 10 updates it).

## 6. Rewrite the paths that hold /var/home/bjk

Rewrite configuration and text, never the database. Each command keeps a `.bak` copy.

1. **Agent profiles.** Repository folders become `~/projects/...` (team.ts expands `~/`). Odrade's desk moves to
   her home:

    ```sh
    cd ~/.config/pi-pocket-team/agents
    sed -i.bak -e 's#/var/home/bjk/projects/odrade#~/agents/odrade#g' -e 's#/var/home/bjk/#~/#g' *.md
    grep -n '/var/home/bjk' *.md                               # nothing
    ```

    Then the front matter for homes. The code that reads `home:` comes in step 10; until then the drop-in ignores the
    field, so it is safe to add now:
    - every agent and Odrade: add `home: ~/agents/<id>`;
    - Odrade: replace `workspace: ~/agents/odrade` with `home: ~/agents/odrade`;
    - the Clerk: keep `workspace: ~/agents/odrade` (no home: Odrade's home is Odrade's identity);
    - Moneo: replace `workspace: ~/projects/truenas-mcp` with `repositories:` `bketelsen/truenas-mcp: ~/projects/truenas-mcp`
      and `home: ~/agents/moneo` (a workspace that is a repository got worktrees on every delegation).

    **Brian:** the charter text in 2 profiles names Brian's old access. `moneo.md` uses `ssh root@` the NAS: on the VM,
    Moneo uses the truenas MCP (the role-bound key). `teg.md` names `ssh 10.0.1.200` and `ssh bjk@10.0.1.175`: on the
    VM, the team keys and accounts that Teg's fleet PRs made. Brian owns the charters: he edits them, or tells Odrade
    the new words.

2. **The desk configuration:**

    ```sh
    sed -i.bak 's#/var/home/bjk/projects/odrade/desk#/var/home/team/agents/odrade/desk#' ~/.config/pi-pocket-team/desk.json
    ```

3. **Pi's config.** The cross-review prompt and the project trust name the old home:

    ```sh
    sed -i.bak 's#/var/home/bjk/#/var/home/team/#g' ~/.pi/agent/prompts/cross-review.md ~/.pi/agent/trust.json
    grep -rln '/var/home/bjk' ~/.pi/agent --exclude-dir=git --exclude='*.bak'   # nothing
    ```

    `~/.pi/agent/AGENTS.md`, `mcp.json` and the skills use `~/` paths and need no change.

4. **Odrade's plans and AGENTS.md** (her desk is a git folder; commit the change there):

    ```sh
    cd ~/agents/odrade
    grep -rln '/var/home/bjk' AGENTS.md plans/ | xargs -r sed -i \
      -e 's#/var/home/bjk/projects/odrade#/var/home/team/agents/odrade#g' -e 's#/var/home/bjk/#/var/home/team/#g'
    git commit -am "Paths for the team VM"
    ```

    `desk/` (generated), `decisions/` and `reports/` are history: leave them.

5. **Repository AGENTS.md files.** Only `homewiki/AGENTS.md` names `/var/home/bjk` today. Bellonda changes it with a
   PR in that repository. Search again on the day: `grep -rln /var/home/bjk ~/projects/*/AGENTS.md ~/projects/frostyard/*/AGENTS.md`.

## 7. First start, local only

```sh
sudo systemctl start pi-pocket@local          # start only; not enabled yet
journalctl -u pi-pocket@local -n 50 --no-pager
journalctl -u pi-pocket@local | grep -o 'http://127.0.0.1:8787/login?token=[^ ]*' | tail -1
```

Open the sign-in link through an ssh tunnel (`ssh -L 8787:127.0.0.1:8787 team@VM_IP`). Do not paste the link in a
chat. Then run the checks in step 8. When a check fails, stop and use the rollback.

## 8. Checks

| Check         | How                                                                                      | Expect                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Version       | `git -C ~/projects/pi-pocket describe --tags`                                            | `TAG`                                                                                                            |
| Database      | the session list, the Archived switch                                                    | 700+ sessions, people and settings as on framework                                                               |
| Extensions    | Menu → Extensions                                                                        | Team, Desk, Night shift, Homewiki, MCP and Agent Teams on, no load errors                                        |
| Desk          | the Desk page                                                                            | the open threads of step 2, `desk.json` export writes into `~/agents/odrade/desk`                                |
| Team          | the Team page                                                                            | 11 agents, repository folders under `/var/home/team/projects`, no error                                          |
| gh and git    | a new session in `~/agents`: `gh api user -q .login`; `git config user.name`             | `frostyard-machines`; the machine identity                                                                       |
| ssh           | from that session: `ssh -o BatchMode=yes <host> true` for each host Teg keyed            | no password prompt, no failure                                                                                   |
| No Brian keys | `ls ~/.ssh`; `echo "${SSH_AUTH_SOCK:-unset}"`; `gh auth status 2>&1 \| grep -ci keyring` | team keys only; `unset` or a plain ssh-agent, never `/run/user/*/keyring/ssh`; `0`                               |
| Browser       | ask Pi to open `https://example.com` with the browser tool                               | a snapshot of the page                                                                                           |
| truenas MCP   | the MCP page: truenas on; ask Pi for a read-only truenas tool                            | a pool list, no write                                                                                            |
| Providers     | Menu → Providers                                                                         | each provider signed in; `halogen` (selfie `10.0.1.200:8731`) answers; **Brian:** sign in again where it says so |
| Lessons       | the Team panel's lessons                                                                 | the same lessons as on framework                                                                                 |
| Homewiki      | the Wiki page                                                                            | renders `~/projects/homewiki`                                                                                    |

Odrade's supervisor session and the Clerk keep the desk's threads, digests and sweeper. **Brian:** move both with
Menu → **Working directory** to `/var/home/team/agents/odrade` (only these 2 old sessions move). Then, in
Odrade's session, re-make each schedule from `plans/schedules-DATE.md` with the new paths, in the session where it
belongs.

## 9. Go live

1. Stop the local instance and enable the real one, started at boot:

    ```sh
    sudo systemctl stop pi-pocket@local
    sudo systemctl enable --now pi-pocket@tailscale-serve
    journalctl -u pi-pocket@tailscale-serve | grep -o 'https://[^ ]*/login?token=[^ ]*' | tail -1
    ```

2. **Brian:** open the link once on the phone and once on the desktop (the address is new, so each device signs in
   again; a cookie lasts a year). Star each agent home in **New** → Folder (favorites give "New session in irulan"
   in the launcher).
3. **Brian:** archive the old sessions (Sessions → Folders, the groups under `/var/home/bjk`; Ctrl/⌘+click selects
   many). They stay readable under Archived. Keep Odrade's and the Clerk's sessions.
4. Odrade resumes the shifts. She closes or re-delegates each desk thread whose folder is gone.
5. Reboot test: during the next reboot window, check that Pocket is up after the VM boots, and that the night shift
   and the desk resume.

## 10. Agent homes and the new drop-ins

Do this after step 9 holds for 1 day, with the agent-homes PRs of pi-pocket-team merged.

```sh
cd ~/projects/pi-pocket-team && git pull && npm test && npm run typecheck && npm run lint
npm run install-check          # read the list: only the files you meant
npm run install-extension      # each written module reloads live; no restart
node homes/seed.mjs --check    # read the AGENTS.md texts
node homes/seed.mjs            # makes ~/agents/<id>/ for each profile with home:, git init, 1 commit
```

The seed never overwrites a file, so Odrade's desk keeps its own AGENTS.md. Each home is a local git repository with
no remote; the Incus snapshots of the VM are its backup.

## 11. Retire framework's start

On framework:

```sh
mv ~/bin/pocket-start ~/bin/pocket-start.retired-DATE
mv ~/.pi-pocket ~/.pi-pocket.framework-DATE      # a plain npm start can then not start the old data
```

Keep `~/.pi-pocket.framework-DATE`, `~/.pi-pocket.backup-DATE` and the 4 config folders for 2 weeks. framework's
checkouts stay; Brian deletes them when he wants the disk.

## Rollback

Any time before step 11, and with framework's data unchanged since step 3:

1. On the VM: `sudo systemctl disable --now pi-pocket@tailscale-serve pi-pocket@local`. Check: `systemctl is-active` says
   inactive for both.
2. On framework: `mv ~/.pi-pocket.framework-DATE ~/.pi-pocket` (after step 11 only), `mv ~/bin/pocket-start.retired-DATE ~/bin/pocket-start`,
   then `pocket-start`.
3. Re-make the schedules on framework from `plans/schedules-DATE.md` (step 2 cancelled them there too).
4. Work done on the VM after the cut-over is on GitHub only (PRs and issues). The VM's database cannot go back to
   framework: its paths and its homes are new.

To retry the VM later: restore the snapshot (`incus snapshot restore VM pre-cutover-DATE` on minideb), then start
again at step 2.

## Not in this runbook

- The VM, the team user, its keys, the UDM reservation, the reboot window timer and the NAS account: Teg's fleet
  PRs (thread T330).
- nsl-builder's memory change on minideb (12 GiB and a swap file; never on a Monday morning; run the Images job once
  after it): Duncan and Teg.
- A backup job for the VM to the NAS: Teg (hosts.md, section d).
