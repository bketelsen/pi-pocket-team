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
- **It never overwrites a file and never deletes one.** An `AGENTS.md` that is there stays as it is:
  the agent owns its home after the seed. To take a changed template, move the old file away first.
- **It never adds a remote and never pushes.** A home is backed up by the machine, not by GitHub.
- `PI_POCKET_TEAM_AGENTS` points it at another profiles folder, for a test.
