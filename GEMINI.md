@AGENTS.md

## Gemini CLI and Antigravity

- The shared rules above apply in full: definition of done, scope discipline, git, parallel work.
- Run each independent gap (TLS client options, `dns`, Brotli, DH/ECDH, HTTP/2, `node:test`) as its own agent in its own git worktree
  or branch. Agents never edit the same files. `quickjs/native`, `quickjs/prebuilt`, generated `intl-*.js` and `dist/` are
  single-writer: one agent owns them at a time, and all C work is merged before the one `pnpm prebuilts`.
- Before handing back, an agent lists the commands it ran (Biome, `tsc`, `pnpm build`, the suite, the corpus it diffed against Node.js
  24.21.0 and 26.9.0) and their results, and names anything it skipped and why.
- Long jobs (Intl data generation, `pnpm prebuilts`, Wine and Docker tests) run as background terminals; confirm the job finished
  before reading its output.
- Commit locally after green checks; do not push unless the user asks.
