# Native synchronization services

`node scripts/install.mjs --root <InfoHub clone>` installs the CLI and native user service. Supply `--infohub-url <repository>` on first setup. The service runs the existing foreground `infohub sync run`; no desktop download or application release is involved. Content, validation, draft backups, network retries and the PID lease remain owned by `sync/`.

| Platform | Registration | Login / restart | Log |
| --- | --- | --- | --- |
| macOS | `~/Library/LaunchAgents/de.eloyzh.infohub-sync.<clone UUID>.plist` | GUI login, KeepAlive, 5 s throttle | `<clone>/.git/infohub-sync/service.log` |
| Linux | `~/.config/systemd/user/de.eloyzh.infohub-sync.<clone UUID>.service` | user manager/default.target, Restart=always after 5 s | same |
| Windows | scheduled task `de.eloyzh.infohub-sync.<clone UUID>`; cached XML under `~/.config/infohub/tasks/` | S4U login trigger plus a one-minute recovery trigger, RestartOnFailure (999 retries), IgnoreNew | same |

Node and Git come from the stable runtime paths in `~/.config/infohub/config.json`. Native definitions preserve Unicode and spaces and construct a minimal PATH. Windows uses a small Node process entry for log redirection and an IPC stop channel; it starts exactly the same foreground CLI with `--parent-stdio`. The task owns retry policy. A periodic native trigger also recovers a dead task when Task Scheduler does not apply RestartOnFailure to the prior execution. `IgnoreNew` leaves a healthy long-running instance untouched, and the clone lease is the final guard. It does not implement another sync loop or infer Git status.

Repeat installation retains the clone UUID. An unchanged registration and active process are reused without rewriting its native definition. A changed runtime/root/definition is stopped gracefully before replacement. Previous task identities belonging to a moved clone are retired; copied `.git` metadata cannot claim another clone's task. The clone PID lease still prevents simultaneous loops, including a manually started one. Installation refuses to start another host when an unrelated loop remains active.

Installation checks the native user session and first-use dirty-content guard before retiring the desktop. It reports service readiness only after the same process has completed a successful fetch. An offline repository or inaccessible user service manager is an installation error, not a healthy empty state. Re-run the same installer after correction; do not delete Git locks. First-use uncommitted content still requires an explicit one-time `infohub sync run --include-existing` by someone authorized to let idle content be committed, then Ctrl+C before installation.

## Desktop retirement

The installer detects InfoHub Workbench and old Otterly names in the standard application locations and per-user login registrations. For a running instance it invokes the existing `--quit` single-instance entry, then waits for the application and sync lease to stop. This follows save/cancel, session persistence and Git-child cancellation inside the old application. Cancellation, an old version without this entry, permissions or a shutdown timeout stop migration before deleting the application. Exit from its tray/application menu once and retry. No SIGKILL or Windows `taskkill /F` is used to migrate the application.

After safe exit the installer removes the app bundle/AppImage or invokes the Windows NSIS uninstaller with `/S /KEEPAPPDATA`, and removes its own product's login entries. A system Linux Debian package is removed through its package manager (`sudo -n dpkg --remove info-hub-workbench` if needed); if permission is unavailable, the installer stops for the user to uninstall it. Unknown package installations are not deleted by guessing.

Preferences, registry of vaults, sessions, logs and local caches are retained. This includes the application identifier's user config/data directories (the nested `otterly` state), and `<InfoHub>/.git/infohub-workbench/`. They cannot become sync drafts and can help recover old UI state. The InfoHub clone, its Git metadata, draft identity and user credentials are never removed. The browser owns its new UI settings locally; it does not automatically import desktop sessions.

## Status and diagnostics

`infohub sync status` remains version 1. `installed` continues to mean a valid per-clone sync configuration, not a verified OS registration. `manager` is `launchd`, `systemd`, `task-scheduler`, `docker` or `foreground`; it describes the registered/recent owner. The per-clone `.git/infohub-sync/service.json` records the registration location and log path. `running` independently checks the daemon PID lease; registration alone never implies the loop is alive. Network failures remain visible under pending/backoff. `brief` tells a stopped desktop user to check the system user service/log or re-run the installer; it no longer asks for Workbench.

Use `infohub sync logs` to locate the log. To diagnose manually, stop the registered host first, run `infohub sync run` in the foreground, stop with Ctrl+C, and re-run the installer to restore the host. Do not run a foreground loop concurrently with the service.

Native stop/start examples (substitute your UUID):

```text
# macOS: graceful bootout; installer bootstraps again
launchctl bootout gui/<uid>/de.eloyzh.infohub-sync.<UUID>
node scripts/install.mjs --root <clone>

# Linux: SIGTERM to the main process, which cancels/reaps Git before exit
systemctl --user stop de.eloyzh.infohub-sync.<UUID>.service
systemctl --user start de.eloyzh.infohub-sync.<UUID>.service

# Windows: disable recovery triggers, then stop through IPC, never /End
node scripts/service-control.mjs --root <clone>
node scripts/install.mjs --root <clone>
```

macOS needs a logged-in GUI user. Linux needs a working systemd user manager; ordinary login starts the enabled unit, and logging out may stop that user manager unless the administrator intentionally enables linger. The installer does not change linger policy. Windows S4U stores no password and avoids an interactive console, but requires batch-logon permission and noninteractive SSH. EFS/DPAPI-dependent keys or an interactive ssh-agent may be unavailable; the actual first fetch checks that boundary. Do not replace it with a stored account password merely to bypass an error.

Docker-managed server clones are not migrated by this installer; keep their Compose hosting and run only the relevant server deployment procedure. CI exercises native definition loading and a temporary-repository service lifecycle on each native runner, including PID reuse, crash restart and graceful lease release. CI is not evidence of a user's installed application's save prompts, permissions or login-session behavior.
