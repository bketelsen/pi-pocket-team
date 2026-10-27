# Team VM cut-over: the commands for steps 2 to 7

Sheeana, 2026-10-27. This is the copy-paste form of steps 2 to 7 of [the runbook](../team-vm-cutover.md). The runbook
explains each step; this list gives the commands, the check after each one, and the rollback. Run it in this order.
Stop at the first check that fails, and use the rollback at the end.

Steps 2 to 7 stop framework's Pocket. That ends every session, Odrade's and the agents' included, so a person runs
them from a terminal, not from a Pocket session.

## Where each block runs

- **[F]** framework, a terminal in the fleet checkout, with the variables of block A.
- **[T]** the VM as `team`: from [F], `$TEAM_SSH -t sudo -iu team` opens the shell.
- **[A]** the VM as `fleet`: from [F], each command starts with `$TEAM_SSH`.
- **[M]** Minideb: `ssh bjk@10.0.1.175`.
- **[P]** the Pocket app on framework (Brian or Odrade).

## What is done (steps 0 and 1, Sheeana, 2026-10-27)

- Step 0: Teg's hand-over checks pass as `team` (ssh to selfie, minideb and caddy; no sudo; Node v24.22.1; gh as
  `frostyard-machines` from `~/.config/gh/hosts.yml`, no keyring; the machine identity in `~/.gitconfig`; group `kvm`;
  `Linger=yes`; `SSH_AUTH_SOCK` unset; 1 key file for each host; `multi-user.target`).
- Step 1: Pocket `v0.25.0` in `~/projects/pi-pocket` (`npm install`, remote `bketelsen` added); `pi-pocket-team`
  (`npm run link`, `npm test`: 801 pass); `homewiki`; `truenas-mcp` built with mise into `~/.local/bin/truenas-mcp`; the
  32 other profile repositories cloned at the paths the rewritten profiles name (36 folders, none missing);
  Playwright Chromium (Pocket finds it, and it loads a page headless); the unit file equals the runbook's text, and no
  instance is enabled; Tailscale node `pocket` online, operator `team`, HTTPS certificate domain on, no Serve mapping.
- The rewrite of step 6 (`rewrite-paths.mjs`) passed on a throwaway copy of framework's configuration on the VM:
  19 files, a second run changes 0, both team.ts versions read the profiles, and the database copy kept its hash.
  The copy was deleted. After the cross-review, the stricter version (it plans every write, checks the planned
  profiles, and also scans Pi's git packages and links) gave the same result on a throwaway copy on framework.

## Changed from the runbook: access is `local` behind Tailscale Serve

Pocket `v0.25.0` has no `tailscale-serve` access mode. Its launcher accepts only `local`, `lan`, `cloudflare` and
`tailscale` (`src/launcher/access.ts`), although its `docs/systemd.md` and unit file name `tailscale-serve`.
`pi-pocket@tailscale-serve` would fail at once. Pocket's own docs (`docs/features.md`, Notifications) give the
supported form: `tailscale serve` in front of `--access local`. So:

- The VM runs `pi-pocket@local` (127.0.0.1:8787) always, enabled at go-live (step 9).
- `team` (the Tailscale operator) adds 1 Serve mapping at go-live:
  `tailscale serve --bg --https=443 http://127.0.0.1:8787`. It stays in Tailscale's state across reboots.
- Tested on the VM on 2026-10-27, on port 8443 with a test server: the certificate came, and the request arrived
  with `X-Forwarded-Proto: https` (Pocket then sets a Secure cookie). The test mapping is removed.

Steps 2 to 7 do not change: step 7 already starts `pi-pocket@local`.

## A. Set up [F]

```sh
cd ~/projects/fleet && git switch main && git pull --ff-only
test -s ansible/ssh/team_known_hosts && echo known-hosts-ok          # known-hosts-ok
DATE=$(date +%F)
TEAM_SSH="ssh -i $HOME/.ssh/semaphore-fleet-hosts -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$PWD/ansible/ssh/team_known_hosts fleet@10.0.1.176"
FLEET_SSH="${TEAM_SSH% *}"
$TEAM_SSH sudo -n true && echo fleet-ok                               # fleet-ok
git -C ~/projects/pi-pocket describe --tags                           # framework's tag, v0.25.0 today
$TEAM_SSH sudo -iu team git -C projects/pi-pocket describe --tags     # the same tag
```

If the 2 tags differ, bring the VM to framework's tag first (`TAG` is framework's):

```sh
$TEAM_SSH "sudo -iu team bash -c 'cd projects/pi-pocket && git fetch -q --tags origin && git checkout -q TAG && npm install --no-audit --no-fund'"
```

## B. Finish step 1 (Brian)

1. **The TrueNAS key [T].** With the key on the terminal's input, never in a command line or a chat:

    ```sh
    umask 077
    cat > ~/projects/truenas-mcp/.envrc     # paste the 2 lines, then Ctrl+D:
                                            #   export TRUENAS_HOST=<the NAS address>
                                            #   export TRUENAS_API_KEY=<the key of the TrueNAS user team>
    chmod 600 ~/projects/truenas-mcp/.envrc
    stat -c '%a %U' ~/projects/truenas-mcp/.envrc                          # 600 team
    git -C ~/projects/truenas-mcp check-ignore -q .envrc && echo ignored   # ignored
    exit
    ```

    The read-only check is in step 8 (the truenas MCP row). framework's `mcp.json` sets `TRUENAS_ENABLE_WRITES=true`;
    the key's `READONLY_ADMIN` role refuses writes on the NAS side.

2. **The snapshot [M].**

    ```sh
    sudo incus snapshot create --project team team pre-cutover-$(date +%F)
    sudo incus snapshot list --project team team                           # the new snapshot
    ```

## C. Step 2: drain (framework's Pocket keeps running)

1. **[P] Odrade** pauses new delegations and night shifts.
2. **[F] Tasks.** Read-only; the server may run:

    ```sh
    cat > /tmp/pocket-tasks.mjs <<'EOF'
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(`${process.env.HOME}/.pi-pocket/pocket.sqlite`, { readOnly: true });
    console.table(db.prepare("select kind, status, count(*) n from tasks where status <> 'terminal' group by 1, 2").all());
    console.table(db.prepare("select conversation_id session, count(*) n from tasks where kind = '\"pocket.schedule\"' and status = 'sleeping' group by 1").all());
    EOF
    node /tmp/pocket-tasks.mjs
    ```

    On 2026-10-27 17:29 it showed: 1 `pi.generation` waiting, 1 `pi.tool` running, 1 `pocket.background` running,
    9 `pocket.schedule` sleeping (sessions 3194, 35393 with 6, 86344, 99392) and 1 `x.desk.sweeper`. Wait, or stop the
    work in the app, until only `pocket.schedule`, `x.desk.sweeper` and `x.desk.digest` are left.

3. **[F] Unmerged work.** Each line it prints is pushed (a branch and a PR) or named in the cut-over report:

    ```sh
    for top in ~/projects/*/ ~/projects/frostyard/*/; do
      git -C "$top" rev-parse --git-dir >/dev/null 2>&1 || continue
      git -C "$top" worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r w; do
        d=$(git -C "$w" status --porcelain | wc -l); a=$(git -C "$w" rev-list --count @{u}..HEAD 2>/dev/null || echo "?")
        [ "$d" = 0 ] && [ "$a" = 0 ] || echo "$w changed=$d ahead=$a"
      done
    done
    ```

4. **[P] Schedules.** Odrade writes `~/projects/odrade/plans/schedules-DATE.md`: 1 row for each schedule (old
   session, time rule, full text, text with new paths, new session on the VM). **Brian** confirms it. Then each
   schedule is cancelled in its session (`schedule cancel`).
5. **[P] Archive.** **Brian** archives every session except Odrade's supervisor session and the Clerk.
6. **[P] The desk.** Odrade writes and commits `plans/desk-at-cutover-DATE.md` (each open or parked thread, its agent,
   its PRs and issues). **Brian** drops each open or parked thread on the Desk page, reason "team VM cut-over DATE".
7. **[F] Odrade's desk is committed:** `git -C ~/projects/odrade status --short` prints nothing.
8. **[F] Drained:** `node /tmp/pocket-tasks.mjs`: the first table is empty. If a row stays, find it in the app and
   stop it; do not go on.

Rollback here: framework keeps running. Re-make the cancelled schedules in their old sessions from the table.

## D. Step 3: stop framework and back it up

**Brian:** stop Pocket (`q` in the `pocket-start` terminal, or Ctrl+C). Then [F]:

```sh
cat > /tmp/pocket-gate.mjs <<'EOF'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(`${process.env.HOME}/.pi-pocket/pocket.sqlite`, { readOnly: true });
const { n } = db.prepare("select count(*) n from tasks where status <> 'terminal'").get();
console.log(`tasks not terminal: ${n}`);
process.exit(n === 0 ? 0 : 1);
EOF
if compgen -G "$HOME/.pi-pocket/harness.lock*" >/dev/null; then
  echo "STILL RUNNING: stop Pocket first. Nothing copied."
elif ! node /tmp/pocket-gate.mjs; then
  echo "TASKS LEFT, or the database cannot be read: start framework again, drain (C), retry. Nothing copied."
else
  cp -a ~/.pi-pocket ~/.pi-pocket.backup-$DATE && echo STOPPED
fi
```

Go on only after `STOPPED`. From here, framework's Pocket stays stopped unless the rollback starts it.

## E. Step 4: copy to the VM [F]

```sh
set -e
$TEAM_SSH sudo -iu team mkdir -p .pi-pocket .pi/agent .config/pi-pocket-team agents/odrade
rsync -a -e "$FLEET_SSH" --rsync-path="sudo -u team rsync" --exclude 'harness.lock*' ~/.pi-pocket/ fleet@10.0.1.176:/var/home/team/.pi-pocket/
rsync -a -e "$FLEET_SSH" --rsync-path="sudo -u team rsync" --exclude sessions/ ~/.pi/agent/ fleet@10.0.1.176:/var/home/team/.pi/agent/
rsync -a -e "$FLEET_SSH" --rsync-path="sudo -u team rsync" ~/.config/pi-pocket-team/ fleet@10.0.1.176:/var/home/team/.config/pi-pocket-team/
rsync -a -e "$FLEET_SSH" --rsync-path="sudo -u team rsync" ~/projects/odrade/ fleet@10.0.1.176:/var/home/team/agents/odrade/
set +e
```

Check [T]:

```sh
cd ~
node -e 'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(process.env.HOME+"/.pi-pocket/pocket.sqlite",{readOnly:true}); console.log(db.prepare("pragma integrity_check").get().integrity_check, db.prepare("select count(*) n from tasks where status <> ?").get("terminal").n)'
                                                     # ok 0
ls ~/.pi-pocket/harness.lock* 2>/dev/null || echo no-lock          # no-lock
find ~/.pi-pocket ~/.pi ~/.config/pi-pocket-team ~/agents ! -user team | head -3   # nothing
```

## F. Step 5: the links [T]

```sh
cd ~/.pi-pocket/extensions
ln -sfn ~/projects/pi-pocket/node_modules node_modules
ln -sfn ~/projects/pi-pocket/types/pocket.d.ts _pocket.d.ts
ls -l node_modules _pocket.d.ts                       # both point into /var/home/team/projects/pi-pocket
cd ~/projects/pi-pocket-team && npm run install-check
```

`install-check` lists exactly `changed team.ts` and `changed team-web/index.js` (the agent-homes code, installed in
step 10; checked on framework on 2026-10-27). Install nothing now. Another file in the list: stop and ask Sheeana.

## G. Step 6: rewrite the paths [T]

`~/cutover/rewrite-paths.mjs` is the tested copy of `docs/team-vm/rewrite-paths.mjs` in pi-pocket-team. It never
opens the database. It keeps `<file>.bak` once for each changed file outside Odrade's git folder.

```sh
cd ~
node ~/cutover/rewrite-paths.mjs --check      # would change: 19 file(s) or so; read the list; exit 0
node ~/cutover/rewrite-paths.mjs              # REWRITE OK, exit 0
node ~/cutover/rewrite-paths.mjs              # changed: 0 file(s), REWRITE OK
grep -h -e '^home:' -e '^workspace:' ~/.config/pi-pocket-team/agents/{odrade,clerk,moneo}.md
                                              # home: ~/agents/odrade / workspace: ~/agents/odrade / home: ~/agents/moneo
git -C ~/agents/odrade add AGENTS.md plans && git -C ~/agents/odrade commit -qm "Paths for the team VM" && git -C ~/agents/odrade status --short
                                              # nothing (a clean folder)
grep -rln /var/home/bjk ~/projects/*/AGENTS.md ~/projects/frostyard/*/AGENTS.md
                                              # homewiki/AGENTS.md only: Bellonda changes it later with a PR
```

`REWRITE INCOMPLETE` names each file or link that still holds `/var/home/bjk`: fix it by hand (the `.bak` keeps the
original), then run the script again. `STOPPED, nothing written` names a profile whose front matter the script does
not handle (a quoted value, for example), or whose result is not what step 6 asks: fix that profile by hand, then
run the script again. The charter text in `moneo.md` (root ssh to the NAS) and `teg.md` (Brian's ssh
addresses) is **Brian's** to change; it does not block the first start.

## H. Step 7: first start, local only

[F]:

```sh
$TEAM_SSH sudo systemctl start pi-pocket@local
sleep 10; $TEAM_SSH systemctl is-active pi-pocket@local                      # active
$TEAM_SSH sudo journalctl -u pi-pocket@local -n 50 --no-pager                # no error; extensions load
```

**Brian**, sign-in, on framework. Terminal 1, in the fleet checkout, with `TEAM_SSH` from block A (keep it open):

```sh
$TEAM_SSH -N -L 8787:127.0.0.1:8787
```

Terminal 2, in the fleet checkout, define `TEAM_SSH` again (block A), then:

```sh
$TEAM_SSH "sudo journalctl -u pi-pocket@local | grep -o 'http://127.0.0.1:8787/login?token=[^ ]*' | tail -1"
```

Open that link in a browser on framework. Never paste it in a chat. Then run the checks of runbook step 8. When a
check fails, use the rollback.

Then step 8 of the runbook. Add these to it:

- **Brian:** Menu → Providers: sign in again where a provider asks (the copy holds framework's sign-ins).
- After the move of Odrade's supervisor session and the Clerk to `/var/home/team/agents/odrade`, run
  `/team-agent odrade` in Odrade's session and `/team-agent clerk` in the Clerk. Each session keeps a snapshot of its
  profile from framework (old folders); the command takes the rewritten one.
- 1 project lesson (Memory) is for `/var/home/bjk/projects/frostyard/frostyard-org`: it does not apply on the VM.
  Tamalane or Brian adds it again in a session in `~/projects/frostyard/frostyard-org`.

## I. Step 9 in short (go live; after step 8 passes)

[F]:

```sh
$TEAM_SSH sudo systemctl enable pi-pocket@local                              # start at boot; it runs already
$TEAM_SSH sudo -iu team tailscale serve --bg --https=443 http://127.0.0.1:8787
$TEAM_SSH sudo -iu team tailscale serve status                               # https://pocket.goat-snake.ts.net -> 127.0.0.1:8787
$TEAM_SSH "sudo journalctl -u pi-pocket@local | grep -o '/login?token=[^ ]*' | tail -1 | sed 's#^#https://pocket.goat-snake.ts.net#'"
```

**Brian:** open that https link once on the phone and once on the desktop. Never paste it in a chat.

## Rollback

Before step 11 of the runbook, and with framework's `~/.pi-pocket` unchanged since block D:

1. [M] If the team backup timer is applied: stop and disable it, and wait until no backup job runs.
2. [F] Stop the VM's Pocket and its Serve mapping:

    ```sh
    $TEAM_SSH sudo -iu team tailscale serve --https=443 off 2>/dev/null
    $TEAM_SSH sudo systemctl disable --now pi-pocket@local pi-pocket@tailscale-serve 2>/dev/null
    $TEAM_SSH systemctl is-active pi-pocket@local pi-pocket@tailscale-serve       # inactive, inactive
    ```

    Go on only when both say `inactive`.

3. [F] Start framework: `pocket-start`. If framework's data folder is in doubt, restore it first:
   `mv ~/.pi-pocket ~/.pi-pocket.failed-$DATE && cp -a ~/.pi-pocket.backup-$DATE ~/.pi-pocket`.
4. [P] Re-make the schedules in their old sessions from `plans/schedules-DATE.md`. The dropped desk threads stay
   closed: Odrade re-delegates from `plans/desk-at-cutover-DATE.md`. Unarchive a session in the app when needed.
5. The TrueNAS key stays on the VM, unused while Pocket there is stopped. If the VM does not come back, **Brian**
   revokes it in TrueNAS and deletes `~team/projects/truenas-mcp/.envrc`.
6. To try the VM again later: keep a copy of what the VM made **on framework** first, because the snapshot restore
   deletes everything on the VM after the snapshot, this archive included. [F], with the VM's Pocket stopped (item 2):

    ```sh
    $TEAM_SSH sudo -iu team tar -C /var/home/team -czf /var/home/team/vm-after-cutover-$DATE.tgz .pi-pocket .pi/agent .config/pi-pocket-team agents
    rsync -a -e "$FLEET_SSH" --rsync-path="sudo -u team rsync" fleet@10.0.1.176:/var/home/team/vm-after-cutover-$DATE.tgz ~/
    $TEAM_SSH sudo -iu team sha256sum vm-after-cutover-$DATE.tgz; sha256sum ~/vm-after-cutover-$DATE.tgz   # the same hash
    tar -tzf ~/vm-after-cutover-$DATE.tgz >/dev/null && echo archive-ok                                    # archive-ok
    ```

    Only after the same hash and `archive-ok`: [M] `sudo incus snapshot restore --project team team <name>`, with the
    snapshot name of block B.2 (`sudo incus snapshot list --project team team`). Then start again at block C.
