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
  Brian archives them on framework before the stop (step 2) and reads them on the VM under Archived. Nobody sends a message in an old session,
  except the 2 sessions in step 8 (Odrade's supervisor session and the Clerk).
- **No secret in a command line, a file in git, or a report.** The commands below name secrets by path only.
- **Headless** (Brian, T330a: no auto-login). The VM has no graphical login, so nothing may need a desktop session or
  the GNOME keyring. Pocket runs as a system unit (user `team`, linger on). The browser tool runs Chromium headless
  (Pocket starts it with `--headless=new`; no display). gh keeps its token in a file, `~/.config/gh/hosts.yml`
  (mode `0600`), not in a keyring. Agents reach hosts with key files named in `~/.ssh/config`; `SSH_AUTH_SOCK` is
  unset, or a plain `ssh-agent`, and never `/run/user/*/keyring/ssh`.

## Names used here

Teg's fleet runbook (`fleet` repository, `docs/team-vm.md`, thread T330) sets these; this runbook uses them as
agreed with Teg on 2026-10-27. When fleet changes one, fleet wins.

| Name        | Value                                                                                                              | Who sets it                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| VM          | Incus project `team`, instance `team` on minideb; guest hostname `team`                                            | Teg, fleet                                       |
| LAN address | `10.0.1.176`, a UniFi DHCP reservation for the MAC that fleet pins                                                 | **Brian:** the reservation                       |
| Tailscale   | node `pocket`; Pocket at `https://pocket.goat-snake.ts.net`                                                        | **Brian:** `sudo tailscale up --hostname=pocket` |
| team user   | `team`, home `/var/home/team`, no sudo, group `kvm`, linger on                                                     | Teg, fleet                                       |
| admin user  | `fleet` (sudo); every `sudo` line below runs as `fleet` (`ssh fleet@10.0.1.176`), by Brian or Teg                  | Teg, fleet                                       |
| `TAG`       | the Pocket release framework runs at the cut-over: `git -C ~/projects/pi-pocket describe --tags` (`v0.25.0` today) | framework                                        |
| `DATE`      | the cut-over date, `YYYY-MM-DD`                                                                                    |                                                  |

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
ssh team@10.0.1.176 true                 # the team user can ssh
for h in selfie minideb caddy; do ssh -o BatchMode=yes $h true && echo $h ok; done
id -nG | tr ' ' '\n' | grep -x sudo || echo no-sudo   # no-sudo
node -v                                  # v24.22.1 or newer, /usr/local/bin/node (fleet)
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
(`incus console --project team team --type=vga`) once, and `gh auth login --insecure-storage` as frostyard-machines (device flow; the
flag keeps the token in `~/.config/gh/hosts.yml`, because the VM has no keyring). Teg's runbook owns them. The team ssh
keys have no passphrase: after a reboot nobody is there to unlock them. Their file mode and the VM protect them.

## 1. Prepare the VM (no Pocket data yet; framework keeps running)

1. **Tools.** Fleet's `team_vm` role installs a pinned `gh` and Node.js 24.22.1 or newer (24.x, under
   `/usr/local/lib/fleet`, linked as `node`, `npm` and `npx` in `/usr/local/bin`; Snow's `/usr` is read-only,
   `/usr/local` is not). Pocket's docs/systemd.md wants a system Node, and the unit uses `/usr/local/bin/node`.

    ```sh
    command -v node gh; node -v; gh --version
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

4. **The truenas MCP server.** It needs Go (from its `go.mod`) through mise. Install mise for `team` when it is not
   there, and build with `mise exec`, which needs no shell setup:

    ```sh
    command -v mise || curl -fsSL https://mise.run | sh      # installs ~/.local/bin/mise
    cd ~/projects/truenas-mcp && ~/.local/bin/mise install && ~/.local/bin/mise exec -- make build
    install -m 0755 build/truenas-mcp ~/.local/bin/truenas-mcp
    ```

    (Where `mise` was already on `PATH`, use that one instead of `~/.local/bin/mise`.) Then:

    **Brian:** create the TrueNAS user and its role-bound API key in the TrueNAS UI (Teg's NAS step names the role).
    Write `~/projects/truenas-mcp/.envrc` (git ignores it; mode `0600`) with `TRUENAS_HOST` and `TRUENAS_API_KEY`
    for that key. `~/.pi/agent/mcp.json` reads it from there, by the same path as on framework, so its entry needs no
    change. Never paste the key in a chat or a command line.

5. **The browser tool.** Install Playwright's Chromium for the team user (Snow carries its libraries):

    ```sh
    cd ~/projects/pi-pocket && npx playwright install chromium
    ls ~/.cache/ms-playwright/                         # chromium-* and chromium_headless_shell-*
    ```

6. **Tailscale.** **Brian:** as `fleet`, sign the VM in to the tailnet once: `sudo tailscale up --hostname=pocket`.
   Fleet's role then runs `sudo tailscale set --operator=team` (docs/systemd.md requires it for `tailscale-serve`).
   Check that HTTPS certificates are on in the tailnet. Fleet adds no Serve mapping: in `tailscale-serve` mode,
   Pocket's launcher adds and removes it.

    ```sh
    tailscale status | head -3     # as team: the node pocket is online
    ```

7. **The systemd unit** (a system unit, run as `team`; it starts at boot with no login). Fleet's `team_vm` role owns
   `/etc/systemd/system/pi-pocket@.service`: it installs this exact file and runs `systemctl daemon-reload`, and never
   enables, starts or restarts an instance. The file is Pocket's `contrib/systemd/pi-pocket@.service` (v0.25.0)
   with these changes: user `team`, the paths under `/var/home/team`, `/usr/local/bin/node`, no `StateDirectory`
   (the data folder is not `/var/lib/pi-pocket`), and `UnsetEnvironment` (headless, T330a). Check that the installed
   file is this one:

    ```ini
    # Pi Pocket on the team VM, from Pi Pocket's contrib/systemd/pi-pocket@.service (v0.25.0), run as the team user.
    # The instance name is the access mode: pi-pocket@local (first start of the cut-over) or pi-pocket@tailscale-serve.
    # Managed by fleet (team_vm role): it installs this file and runs daemon-reload only. Brian enables, starts and stops.
    # Source of the values: bketelsen/pi-pocket-team docs/team-vm-cutover.md, step 7.

    [Unit]
    Description=Pi Pocket (%i access)
    Documentation=https://github.com/TannerMidd/pi-pocket/blob/main/docs/systemd.md
    Wants=network-online.target
    After=network-online.target tailscaled.service

    [Service]
    Type=simple
    User=team
    Group=team

    Environment=POCKET_HOME=/var/home/team/projects/pi-pocket
    Environment=HOME=/var/home/team
    Environment=PATH=/var/home/team/.local/share/mise/shims:/var/home/team/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin
    EnvironmentFile=-/etc/pi-pocket.env
    # Headless (T330a): no keyring agent, no display. ssh uses the key files in ~/.ssh/config.
    UnsetEnvironment=SSH_AUTH_SOCK DISPLAY WAYLAND_DISPLAY

    WorkingDirectory=/var/home/team/agents

    # %i is the access mode: local, lan, cloudflare, tailscale, or tailscale-serve.
    ExecStart=/usr/local/bin/node ${POCKET_HOME}/bin/pi-pocket.js --access %i --port 8787 --data /var/home/team/.pi-pocket --cwd /var/home/team/agents

    Restart=on-failure
    RestartSec=5
    KillMode=mixed
    TimeoutStopSec=20

    UMask=0077
    LimitNOFILE=65536

    NoNewPrivileges=yes
    PrivateTmp=yes

    [Install]
    WantedBy=multi-user.target
    ```

    Keep `NoNewPrivileges=yes` (agents need no sudo on the VM) and `PrivateTmp=yes`. If nsl machines fail under the
    unit (systemd-vmspawn), remove `NoNewPrivileges` first (a fleet PR) and say so in the cut-over report.
    `WorkingDirectory` must exist before a start: step 4 makes `~/agents`. The unit runs with no login and no
    desktop: ssh uses the key files in `~/.ssh/config` (`IdentitiesOnly yes`, `IdentityAgent none`), gh the token
    file, and the browser tool Chromium headless. Linger (fleet) keeps the team user's own systemd manager running
    for nsl machines.

    `team` has no sudo, so only `fleet` (Brian or Teg) starts and stops the unit. Brian controls restarts; Menu →
    **Update Pi Pocket** restarts Pocket from inside, as `team`. When Pocket's own template changes in a release,
    compare it with this file before the update.

8. **Snapshot.** Teg or **Brian:** on minideb, `incus snapshot create --project team team pre-cutover-DATE`.

## 2. Drain framework (the quiet window)

Pick a day-time window, outside the night shift and outside the VM's reboot window (07:00-08:00 local). Odrade
pauses new delegations and night shifts.

The goal of the drain: when Pocket stops, the database holds **no task that is not terminal**. Pi Durable resumes
every such task at the first start on the VM: a generation, a tool call, a schedule, a night shift, or a desk sweep
there would run in an old session whose folder is gone, or send a message to one.

1. **Running now.** No running tool call, generation, subagent, background task or night shift. On framework, this
   script reads the database read-only (the server may run):

    ```sh
    cat > /tmp/pocket-tasks.mjs <<'EOF'
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(`${process.env.HOME}/.pi-pocket/pocket.sqlite`, { readOnly: true });
    console.table(db.prepare("select kind, status, count(*) n from tasks where status <> 'terminal' group by 1, 2").all());
    console.table(db.prepare("select conversation_id session, count(*) n from tasks where kind = '\"pocket.schedule\"' and status = 'sleeping' group by 1").all());
    EOF
    node /tmp/pocket-tasks.mjs
    ```

    Wait, or stop the work in the app, until the first table holds only what steps 3 and 5 below remove
    (`pocket.schedule`, `x.desk.sweeper`, `x.desk.digest`). Brian runs the cut-over from a terminal, not from a
    Pocket session, so no session of the cut-over is in the table.

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
   2026-10-27). In each listed session, ask Pi for `schedule list`. Write each schedule as 1 row in
   `plans/schedules-DATE.md` of Odrade's desk (on framework `~/projects/odrade/plans/`), with 5 columns: old session,
   time rule, full text, the text with new paths, and the **new session** on the VM where it goes. The new session is
   Odrade's supervisor session (moved in step 8), or a new session in an existing VM folder (a home or a repository).
   Never an old session. Odrade fills the table; **Brian:** confirms it. Then cancel each schedule in its session
   (`schedule cancel`).

4. **Archive the old sessions.** **Brian:** on framework, archive every session except Odrade's supervisor session and
   the Clerk (Sessions → Folders; Ctrl/⌘+click selects many). They stay readable under Archived. The desk reads
   this: it sends no close-out to an archived agent session, and a repair for a thread whose agent session is
   archived goes to Odrade instead (`planRepairs` and `closeoutDue` in `desk.ts`). A closed thread can still open
   again when its PR fails or conflicts (`repairReopen`), but its wake-up then goes to Odrade, never to the old agent
   session.

5. **The desk.** The desk's sweeper sends close-out and repair messages to the agents' sessions, which are old
   sessions on the VM. It ends only when its supervisor has no thread that is not closed; the digest ends when no
   news waits. So every open or parked thread must close, after step 4:
    - Odrade first writes the record: `plans/desk-at-cutover-DATE.md` in her desk, with each open or parked thread,
      its agent, and each PR and issue on it (from the Desk page or the export in `desk/`). She commits it.
    - **Brian:** on the Desk page, **Drop** each open or parked thread, with the reason "team VM cut-over DATE". A
      dropped thread is closed for good: a repair never opens it again (`desk.ts`, the check for `"dropped"` before
      a reopen), and a close-out goes only to an open thread.
    - Wait until the first table of the script has no `x.desk.sweeper` and no `x.desk.digest`.
    - An open PR keeps its `ready-for-human` label, so Brian still finds it on GitHub. After step 9, Odrade goes
      through the record: each PR or issue that still needs work goes to its owner again with `team_delegate` (a new
      thread and a new session on the VM). Nothing from the record goes to an old session.

6. **Odrade's desk folder.** Commit it (`git -C ~/projects/odrade status` is clean).

## 3. Stop framework and back it up

**Brian:** on framework, run the script of step 2 a last time: the first table must be empty. Then stop Pocket at
once (`q` in the `pocket-start` terminal, or Ctrl+C), and run:

```sh
# on framework: a gate that exits 0 only when it can read the database and every task is terminal
cat > /tmp/pocket-gate.mjs <<'EOF'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(`${process.env.HOME}/.pi-pocket/pocket.sqlite`, { readOnly: true });
const { n } = db.prepare("select count(*) n from tasks where status <> 'terminal'").get();
console.log(`tasks not terminal: ${n}`);
process.exit(n === 0 ? 0 : 1);
EOF

# prints STOPPED and makes the backup only when the server is down and the gate passes
if compgen -G "$HOME/.pi-pocket/harness.lock*" >/dev/null; then
  echo "STILL RUNNING: stop Pocket first. Nothing copied."
elif ! node /tmp/pocket-gate.mjs; then
  echo "TASKS LEFT, or the database cannot be read: start framework again, drain (step 2), retry. Nothing copied."
else
  cp -a ~/.pi-pocket ~/.pi-pocket.backup-DATE && echo STOPPED
fi
```

Go on only after `STOPPED`. From here, framework's `~/.pi-pocket` must not start again unless the rollback says so.

## 4. Copy to the VM

**Brian:** run these on framework, with an ssh login as `team@10.0.1.176` (his own key, for the copy only). They copy
4 folders. They never copy Brian's `~/.ssh`, `~/.config/gh`, `~/.config/gh-machines`, `~/.config/pi-pocket-agents`,
`~/.pi/agent/sessions` (Pi CLI only), or `harness.lock*`.

```sh
set -e    # stop at the first failed copy
ssh team@10.0.1.176 'mkdir -p .pi-pocket .pi/agent .config/pi-pocket-team agents/odrade'
rsync -a --exclude 'harness.lock*' ~/.pi-pocket/ team@10.0.1.176:.pi-pocket/
rsync -a --exclude sessions/ ~/.pi/agent/ team@10.0.1.176:.pi/agent/
rsync -a ~/.config/pi-pocket-team/ team@10.0.1.176:.config/pi-pocket-team/
rsync -a ~/projects/odrade/ team@10.0.1.176:agents/odrade/
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
# as fleet
sudo systemctl start pi-pocket@local          # start only, not enabled yet
sudo journalctl -u pi-pocket@local -n 50 --no-pager
```

**Brian:** sign in as the owner. On his own computer (not on the VM), open a tunnel and keep it open:
`ssh -L 8787:127.0.0.1:8787 fleet@10.0.1.176`. In a second terminal there, read the link:
`ssh fleet@10.0.1.176 "sudo journalctl -u pi-pocket@local | grep -o 'http://127.0.0.1:8787/login?token=[^ ]*' | tail -1"`.
Open it in his browser on that computer. Do not paste the link in a chat. Then run the checks in step 8. When a check
fails, stop and use the rollback.

## 8. Checks

| Check         | How                                                                                      | Expect                                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version       | `git -C ~/projects/pi-pocket describe --tags`                                            | `TAG`                                                                                                                                                                           |
| Database      | the session list, the Archived switch                                                    | 700+ sessions, people and settings as on framework                                                                                                                              |
| Extensions    | Menu → Extensions                                                                        | Team, Desk, Night shift, Homewiki, MCP and Agent Teams on, no load errors                                                                                                       |
| Desk          | the Desk page; after the move below, `desk sync` in Odrade's session                     | no open thread from before (a reopened one tells Odrade, not an agent); the export writes into `~/agents/odrade/desk`; Odrade re-delegates from `plans/desk-at-cutover-DATE.md` |
| Team          | the Team page                                                                            | 11 agents, repository folders under `/var/home/team/projects`, no error                                                                                                         |
| gh and git    | a new session in `~/agents`: `gh api user -q .login`; `git config user.name`             | `frostyard-machines`; the machine identity                                                                                                                                      |
| ssh           | from that session: `ssh -o BatchMode=yes <host> true` for each host Teg keyed            | no password prompt, no failure                                                                                                                                                  |
| No Brian keys | `ls ~/.ssh`; `echo "${SSH_AUTH_SOCK:-unset}"`; `gh auth status 2>&1 \| grep -ci keyring` | team keys only; `unset` or a plain ssh-agent, never `/run/user/*/keyring/ssh`; `0`                                                                                              |
| Browser       | ask Pi to open `https://example.com` with the browser tool                               | a snapshot of the page                                                                                                                                                          |
| truenas MCP   | the MCP page: truenas on; ask Pi for a read-only truenas tool                            | a pool list, no write                                                                                                                                                           |
| Providers     | Menu → Providers                                                                         | each provider signed in; `halogen` (selfie `10.0.1.200:8731`) answers; **Brian:** sign in again where it says so                                                                |
| Lessons       | the Team panel's lessons                                                                 | the same lessons as on framework                                                                                                                                                |
| Homewiki      | the Wiki page                                                                            | renders `~/projects/homewiki`                                                                                                                                                   |

Odrade's supervisor session and the Clerk keep the desk's history, the Clerk's registration and Odrade's lessons.
**Brian:** move both with Menu → **Working directory** to `/var/home/team/agents/odrade`, before anything else in
them. Only these 2 old sessions move; no other old session gets a message. Then re-make each schedule from
`plans/schedules-DATE.md` in its **new session** column, with the new paths: Odrade's moved session, or a new session
that Brian starts in the named VM folder.

## 9. Go live

1. Stop the local instance and enable the real one, started at boot:

    ```sh
    # as fleet
    sudo systemctl stop pi-pocket@local
    sudo systemctl enable --now pi-pocket@tailscale-serve
    journalctl -u pi-pocket@tailscale-serve | grep -o 'https://[^ ]*/login?token=[^ ]*' | tail -1
    ```

2. **Brian:** open the link once on the phone and once on the desktop (the address is new, so each device signs in
   again; a cookie lasts a year). Read it as `fleet` with `sudo journalctl`, as in step 7.
3. Odrade resumes the shifts. Until step 10, nobody starts a session in `~/agents/<id>` (only Odrade's desk exists
   there).
4. Reboot test: during the next reboot window, check that Pocket is up after the VM boots, and that the night shift
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
no remote; the daily backup and the Incus snapshots of the VM are its backup.

**Brian:** then star each agent home in **New** → Folder. Each favorite gives "New session in irulan" (and so on) in
the launcher; a session there takes that agent's identity from the folder.

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

1. Teg or **Brian:** on minideb, stop and disable the daily backup timer of the team VM (when it is applied), and wait
   until no backup job runs: a running job could start VM Pocket again after framework starts. It stays disabled
   while framework serves.
2. On the VM, as `fleet`: `sudo systemctl disable --now pi-pocket@tailscale-serve pi-pocket@local`. Check:
   `systemctl is-active pi-pocket@tailscale-serve pi-pocket@local` says inactive for both. Go on only then.
3. On framework: `mv ~/.pi-pocket.framework-DATE ~/.pi-pocket` (after step 11 only), `mv ~/bin/pocket-start.retired-DATE ~/bin/pocket-start`,
   then `pocket-start`.
4. Re-make the schedules on framework in their old sessions, from `plans/schedules-DATE.md` (step 2 cancelled them
   there too).
5. What does not go back: the VM's database cannot go back to framework (its paths and its homes are new). So the
   sessions, desk threads, lessons, schedules and provider sign-ins made on the VM, the agent homes, and Odrade's desk
   commits made there stay on the VM only. Work pushed to GitHub (PRs, issues) is safe. Before anything removes
   them, keep a copy of the stopped VM's data: as `team`,
   `tar -C ~ -czf ~/vm-after-cutover-DATE.tgz .pi-pocket .pi/agent .config/pi-pocket-team agents`, and copy the file
   to framework. Bring Odrade's desk commits back with `git fetch` from that copy. **Brian:** decides what else to keep.

To retry the VM later: keep the copy of step 5 first. Then restore the snapshot
(`incus snapshot restore --project team team pre-cutover-DATE` on minideb; it deletes everything made on the VM after
the snapshot), and start again at step 2.

## Not in this runbook

- The VM, the team user, its keys, the UDM reservation, the reboot window timer and the NAS account: Teg's fleet
  PRs (thread T330).
- nsl-builder's memory change on minideb (12 GiB and a swap file; never on a Monday morning; run the Images job once
  after it): Duncan and Teg.
- The daily backup (Teg, a host job on minideb at 07:00, after step 9 of this runbook): it stops the active Pocket
  instance, streams a tar of `.pi-pocket` (without `harness.lock*`), `.pi/agent`, `.config/pi-pocket-team`, `agents`
  and `projects/truenas-mcp/.envrc` to a private NAS dataset, and starts the same instance again, also when the tar
  fails. It never starts an instance that was not active before (one server only). The 07:30 reboot waits for it.
  Unpushed work in `projects/` is not in the backup: the desk and the audit track it.
