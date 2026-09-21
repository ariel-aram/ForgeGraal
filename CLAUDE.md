@AGENTS.md

## Claude Code

- The shared rules above apply in full: definition of done, scope discipline, git, parallel work.
- Long jobs (data generation, `pnpm prebuilts`, the full suite with Wine and Docker) run in the background; wait with a monitor on a
  marker the job writes after you clear it. Keep scratch files in the session scratchpad, not the repo.
- For independent gaps, spawn one sub-agent per gap with `isolation: "worktree"` and give it the definition of done from
  `AGENTS.md`. Sub-agents do not touch the single-writer paths (`quickjs/native`, `quickjs/prebuilt`, generated `intl-*.js`, `dist/`);
  the main session merges and does the one prebuilt rebuild and the final full test run.
- Commit locally after green checks; push only when asked.
- `/init` output belongs in `AGENTS.md`; keep this file to Claude-specific notes.
