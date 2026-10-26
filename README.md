# work-ontology

A local-first ontology CLI and Git synchronization toolkit for InfoHub workspaces. Query Markdown objects, follow their relations, validate changes, and keep shared workspaces synchronized. The software is public; your workspace content and Git repository remain yours.

Requires Node.js 24.11 or later and Git 2.38 or later on macOS, Windows or Linux.

```sh
git clone https://github.com/lpmasser/work-ontology.git
cd work-ontology
npm ci
node scripts/install.mjs --infohub-url <your-workspace-git-url> --root <workspace-directory>
```

The initial installation asks for no hard-coded server: supply your own InfoHub Git address with `--infohub-url`. It is saved with the workspace location and runtime paths in `~/.config/infohub/config.json`. Subsequent runs read that configuration. Configure Git authentication separately; do not put passwords or tokens in repository URLs.

The installer sets up the `infohub` command and the workspace's agent instructions/skills, removes obsolete synchronization launchers, and installs [InfoHub Workbench](https://github.com/lpmasser/infohub-workbench) from its signed GitHub Release if absent. Existing desktop applications handle their own updates through the official Tauri updater. Desktop synchronization is managed by the workbench; server synchronization runs in Docker.

An InfoHub workspace supplies `ontology/ontology.json`, Markdown objects, its agent instructions, and any workspace-owned skills. `core/` owns parsing and queries, `cli/` exposes commands, `sync/` owns synchronization, `server/` supplies validation and draft handling, and `hooks/pre-receive` integrates push validation with a Git server.

```sh
infohub brief <project>
infohub find --type work_item
infohub overview
infohub sync status
infohub check
npm test
```

Maintainers: see [AGENTS.md](AGENTS.md). Licensed under [MIT](LICENSE).
