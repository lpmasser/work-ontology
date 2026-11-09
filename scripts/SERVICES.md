# On-demand synchronization and migration

Local agents start synchronization through `infohub brief` or `infohub check`. Installation only installs the CLI, Skill and resident instructions and retires old hosts. No LaunchAgent, systemd service or scheduled task is created. Docker-managed server clones keep their existing continuous hosting; do not run the local installer there.

## Lifecycle

`brief` attempts one fetch/fast-forward before loading the document library, with a 10-second deadline. It reuses `Client.refresh()` and its existing main-branch, Git-operation, active-process and dirty-path-overlap rules. An occupied daemon PID lease skips this exclusive refresh and reports that the existing loop owns synchronization. Offline, timeout and unsafe skips are reported without blocking the brief. The entry then launches `infohub sync run --on-demand` detached if no loop is alive; `check` does the same launch without the opening fetch. Windows uses a hidden detached process. Neither entry waits for the background loop's first fetch.

The existing PID lease arbitrates concurrent starts. A losing on-demand process exits successfully. The loop exits only after a successful fetch confirms local HEAD equals remote main, the worktree is clean, and its fingerprint has stayed unchanged for 600 seconds. Git activity in this repository and local changes reset that interval. Ten minutes covers normal Agent thinking and command gaps without keeping a process for an unused login session. The original fetch/draft/auto-commit defaults remain 5/180/1800 seconds. Dirty content and unpublished commits keep the loop alive through draft backup, idle validation, commit and push; failed/offline publication does not count as ready to exit.

For an isolated short exit proof use `infohub sync run --on-demand --exit-after-seconds 2 --fetch-seconds 0.2`. The exit interval is a run-only option, never saved to the clone configuration. Ordinary `sync run` and Docker hosting run continuously. First-time dirty content still requires an explicitly authorized `sync run --include-existing`; installation itself does not authorize auto-committing that content.

## Status and diagnostics

`infohub sync status` remains version 1 and a read-only filesystem projection. `installed` means the clone has valid sync settings, never an OS registration. `manager` describes the current/most recent process: `on-demand`, `foreground`, or `docker`; an unused local clone defaults to `on-demand`. Old service metadata is no longer a hosting authority. `running` checks the PID lease independently; `running: false` is normal for an idle on-demand clone. Pending errors and last observed unpublished local content remain visible in `brief`; a stopped Docker loop remains a concern. Timestamps and dirty paths describe the last completed observation, not a fresh Git inspection.

`infohub sync logs` locates the log. Detached local loops append to `.git/infohub-sync/sync.log`; foreground loops output directly, and servers use `docker logs <container>`. To diagnose manually, wait for idle exit or send SIGTERM to the exact local PID shown by status on macOS/Linux, then run `infohub sync run` in the foreground and stop it with Ctrl+C. On Windows, let an existing detached loop finish before starting a foreground diagnostic loop. There is no service recovery watchdog; the next brief/check starts a stopped loop.

## Retiring old native hosts

The installer reads the existing clone identity without generating another UUID. It handles only that UUID and its recorded moved-copy predecessors, and refuses to claim registrations copied from a different live clone. It never scans and deletes other clones' tasks.

- macOS: `launchctl bootout` safely unloads the exact registered LaunchAgent, waits for the daemon lease to stop, then removes `~/Library/LaunchAgents/de.eloyzh.infohub-sync.<UUID>.plist`.
- Linux: `systemctl --user disable --now` stops and disables the exact unit, waits for the lease, removes `~/.config/systemd/user/de.eloyzh.infohub-sync.<UUID>.service`, then reloads the user manager. A machine without an old unit needs no systemd session.
- Windows: query the exact UUID task even if its cached XML is absent, disable its triggers, request shutdown through the old running runner's IPC pipe, wait for runner and daemon exit, then delete the task and cached XML. `/End` and forced process termination are never used. An old task that cannot stop safely causes installation to fail before deletion.

After safe retirement, obsolete `.git/infohub-sync/service.json` and `service-runner.json` are removed. Identity, settings, logs, draft state and Git locks are retained. Re-running installation creates no new background registration and starts no loop.

## Desktop retirement

The existing retirement path remains: invoke InfoHub Workbench/Otterly's `--quit` single-instance entry, wait for save/cancel handling and sync lease release, then remove its application and known login entries. Cancellation, permissions, an unsupported old build or timeout stops migration before removal; exit through the application's menu and retry. Windows uses its registered NSIS uninstaller with `/S /KEEPAPPDATA`; Linux packages use their package manager. Preferences, vault registry, sessions, logs, caches and `.git/infohub-workbench/` remain. The content repository and credentials are never removed.

## Development and evidence

Use a temporary HOME/USERPROFILE and temporary repositories for all synchronization/installer development and checks. Native boundaries in tests are injected; CI on ubuntu, macOS and Windows runs `npm test` without service registration. Real-machine migration belongs only to final acceptance. CI does not prove a user's login prompts, credentials, application save dialogs or macOS background-items database cleanup.
