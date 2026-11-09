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

The installer sets up the `infohub` command and agent instructions/skills, safely retires installed InfoHub Workbench/Otterly applications and their login entries, and removes this clone's old native synchronization registration. It does not register or start any service. Use the browser frontend to read and edit; agents continue using their local clone.

`infohub brief` first attempts a safe fetch/fast-forward within 10 seconds, explains offline or unsafe skips, then launches the existing `infohub sync run` detached if no loop is alive. `infohub check` also ensures a loop is running. The PID lease prevents duplicate loops. With an existing loop, brief skips its exclusive opening refresh and leaves synchronization to that loop. Windows launches without a console. Local on-demand loops exit after 10 continuous minutes with a clean workspace and all commits published; this keeps short Agent pauses covered without running throughout an unused login session. Dirty content still follows the existing draft backup and 30-minute idle auto-commit policy. Docker and manual foreground loops keep running.

Desktop preferences, sessions and `.git/infohub-workbench` caches are retained; the content repository is never removed. If an old desktop build cannot handle `--quit`, or a save prompt is cancelled, migration stops before removal and asks you to exit from the application once. See [synchronization and migration](scripts/SERVICES.md) for lifecycle, status and platform limits.

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
