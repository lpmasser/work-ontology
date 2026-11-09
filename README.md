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

The installer sets up the `infohub` command and the workspace's agent instructions/skills, safely retires installed InfoHub Workbench/Otterly applications and their login entries, and registers one native user service per clone. macOS uses LaunchAgent, Linux uses a systemd user service, and Windows uses an S4U scheduled task with a graceful stop channel. The same foreground `infohub sync run` owns synchronization on every platform; server containers keep their existing Docker hosting. The installer no longer downloads desktop applications. Use the browser frontend to read and edit; agents continue using their local clone.

Re-running the installer preserves the clone UUID and reuses an unchanged registration and live process. It waits for a successful fetch before reporting ready. Desktop preferences, sessions and `.git/infohub-workbench` caches are retained; the content repository is never removed. If an old desktop build cannot handle `--quit`, or a save prompt is cancelled, migration stops before removal and asks you to exit from the application once. See [native services and migration](scripts/SERVICES.md) for stop/restart commands and platform limits.

An InfoHub workspace supplies `ontology/ontology.json`, Markdown objects, its agent instructions, and any workspace-owned skills. `core/` owns parsing and queries, `cli/` exposes commands, `sync/` owns synchronization, `server/` supplies validation, draft handling, and the authenticated Web service ([API contract](server/WEB-API.md)), and `hooks/pre-receive` integrates push validation with a Git server.

```sh
infohub brief <project>
infohub find --type work_item
infohub overview
infohub sync status
infohub check
npm test
```

Maintainers: see [AGENTS.md](AGENTS.md). Licensed under [MIT](LICENSE).

Use `node scripts/install.mjs --web-url https://your-infohub.example --web-user alice` to save the browser address and your exact Web username. The installer retains them on later runs. Object listings include `/o/<ontology_id>` links when configured; JSON objects also have `url`. Local overview uses `webUser` (or a username array edited in the user config) to exclude users' own annotations from blocked-work reminders; it never guesses from the OS username.

Annotations are standalone body comments, `<!-- 批注 YYYY-MM-DD author：content -->`, with multiline content allowed. Core owns their parsing and validation; fenced code examples and frontmatter are ignored. Project `brief` lists all annotated objects. Overview's blocked work comes from Agent annotations, with no `attention` field fallback. See [the API contract](server/WEB-API.md) for source lists, line positions, format errors and `/api/annotations`.
