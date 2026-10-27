# Agent homes

`homes/seed.mjs` makes and updates the home folder of each named agent: `~/agents/<id>/`, a local git
repository with no remote. The profile in `~/.config/pi-pocket-team/agents/<id>.md` names the folder
with `home:` (`/var/home/bjk/projects/odrade/reports/2026-10-27-agent-homes/README.md`, sections 3
and 4). A profile with no `home:` is listed and skipped.

For each home it makes the folder, writes `AGENTS.md` (the charter copy, the repositories table and
the rules), makes `notes/`, `plans/` and `reports/` with a `.gitkeep` each, writes a `.gitignore`, and
when the folder has no `.git` it runs `git init -b main`, `git add -A` and 1 commit
`Seed <Name>'s home`.

```sh
node homes/seed.mjs                 # seed every profile that names a home
node homes/seed.mjs --check         # write nothing; print each step and each AGENTS.md text
node homes/seed.mjs --agent irulan  # 1 agent only
```

- **A folder that is already a git repository is left as it is.** The seed adds no file there and makes no
  commit: Odrade's desk `~/agents/odrade` is an existing repository, and a new file in it would stay
  uncommitted.
- **It refuses a home that a link could take a write out of.** When the home, `notes/`, `plans/`, `reports/`,
  `AGENTS.md` or `.gitignore` is a symbolic link, that home is refused and the other homes still seed.
- **Its git uses no configuration of the machine.** The seed reads 2 settings only, `user.name` and
  `user.email` (a read runs nothing), and then runs every git call with no global or system config: no
  signing, no filter, no hook and no filesystem monitor can run a program. Every `GIT_` variable of the
  environment is dropped first (`GIT_DIR`, `GIT_CONFIG`, `GIT_TRACE*` and the rest), so the shell cannot
  change what the seed does. Without both settings it refuses the home.
- **A discovery failure is never a guess.** Only `git rev-parse` saying "not a git repository" means the
  folder is free; any other failure, such as "dubious ownership", refuses that home before any write.
- **It never overwrites a file and never deletes one.** An `AGENTS.md` that is there stays as it is:
  the agent owns its home after the seed. To take a changed template, move the old file away first.
- **It never adds a remote and never pushes.** A home is backed up by the machine, not by GitHub.
- **The exit code says what happened:** 0 when every home seeded or was left as it is, 1 when any home was
  refused (each one printed by name, and the other homes still seed), 2 on a bad option.
- `PI_POCKET_TEAM_AGENTS` points it at another profiles folder, for a test.
