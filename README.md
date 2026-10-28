# SkillSync

Keep the same AI agent skills and Codex plugins available across all of your devices.

SkillSync stores one canonical copy of each skill in a private GitHub repository, projects the skills you choose into Codex, Claude, OpenCode, Hermes, Grok Bot, or any custom skill folder, and keeps every device in sync in the background. It can also apply named Codex plugin profiles across devices.

## Start with an agent

Paste this into any terminal-capable coding agent:

```text
Set up SkillSync completely on this device.

1. Check for Node.js 20 or newer, Git, GitHub CLI, and an authenticated `gh auth status`. Stop and tell me what is missing before continuing.
2. Ask whether I already have a SkillSync vault. If I do, run `npx -y @akshar5/skillsync@latest setup --repo OWNER/REPO`. Otherwise, run `npx -y @akshar5/skillsync@latest setup`.
3. Let setup detect my Codex, OpenCode, Claude Code, Hermes, and Grok Bot skill folders. Show me any existing standalone skills and ask which ones I want to import. Do not import or resolve differing skill content without asking me.
4. Install the persistent CLI with `npm install -g @akshar5/skillsync@latest`, then run `skillsync service install`.
5. Ask whether I want to sync global agent instructions. If I do, inspect my existing Codex, OpenCode, and Grok Bot AGENTS.md files, import the version I choose, and link each installed provider's global path to that profile. Only manage CLAUDE.md when Claude Code is installed. Preserve any differing unmanaged file. Grok Bot needs a separate always-apply skill to use the linked file.
6. Ask whether I want to sync installed Codex plugins. If I want one universal profile, run `skillsync plugins import --name shared --auto-adopt`; every current and future enabled user-managed plugin on an assigned device will join it. If I want a selected profile instead, inspect `codex plugin list --json`, ask which plugins are portable, and pass those exact selectors with `--plugin PLUGIN@MARKETPLACE`. Assign the profile to the devices I choose. Explain that connector sign-ins are separate and must never be copied.
7. Verify `skillsync doctor`, `skillsync status`, `skillsync matrix`, `skillsync instructions status`, `skillsync plugins status`, and the background service. Report the vault, detected targets, auto-adoption settings, instruction and plugin profiles, service state, and anything that still needs my decision.
```

The `npx` command starts setup without requiring an existing installation. The global installation gives the background service a stable executable to run.

## Quick start

Requirements:

- Node.js 20 or newer
- Git
- [GitHub CLI](https://cli.github.com/) authenticated with `gh auth login`
- A private GitHub repository for your skill vault

Install SkillSync:

```bash
npm install -g @akshar5/skillsync@latest
```

Create or select a private vault and detect supported agent folders:

```bash
skillsync setup
```

Connect to an existing SkillSync vault instead:

```bash
skillsync setup --repo OWNER/REPO
```

Setup detects Codex, Claude Code, OpenCode, Hermes, and Grok Bot folders. Rerunning setup adds new targets and preserves existing target settings. Add a custom skill folder only when needed:

```bash
skillsync target add my-agent ~/.config/my-agent/skills
```

Repeating `setup` or `connect` for the configured checkout preserves its saved device ID and path, including after a hostname change or when using a directory alias. A different checkout uses an ID derived from the current hostname.

Then install the background service:

```bash
skillsync service install
```

On Linux, the service unit goes in `$XDG_CONFIG_HOME/systemd/user` when `XDG_CONFIG_HOME` is an absolute path, or `~/.config/systemd/user` otherwise.

The service uses an executable `skillsync` from PATH, skipping same-named directories. If none is available, it uses the current Node executable and CLI file.

Command availability checks use the running process's PATH rather than loading a login profile.

Repeat the install, existing-vault setup, and service steps on each device.

SkillSync stores local configuration in `~/.config/skillsync/config.json`. Read errors, malformed configuration, and broken symlinks in the config path are reported instead of silently switching vaults. Repair the file or symlink before retrying; an absent config file still uses the default vault at `~/.skillsync/repo`.

Relative vault paths passed to `setup --path` or `connect --path`, target paths, and `--scan-path` values are saved as absolute paths based on the directory where you configure them. Later commands and the background service keep using those locations. To anchor a relative path saved by an older version, rerun its setup, connect, or target-add command from the original directory.

## Interactive UI

Run SkillSync without a command:

```bash
skillsync
```

Use the UI to browse skills, toggle installs, view the skill matrix, manage devices and targets, or change settings. Arrow keys move, Space toggles selected items, Enter applies, and Esc goes back.

## See every skill across every device

```bash
skillsync matrix
```

The matrix gives you one clean view of your vault:

```text
Skill          | laptop | workstation | server
---------------+--------+-------------+-------
git-helper     | ✓      | ·           | ✓
docs-writer    | ○      | ·           | ·
terminal-tools | ✓      | ✓           | ✓

✓ assigned  ○ detected locally  · absent
```

`○` means SkillSync found a local copy even though the skill is not assigned to that device. This distinction prevents cleanup from deleting skills that are still present somewhere.

Open the editable matrix directly:

```bash
skillsync matrix --edit
```

Choose a skill, check or uncheck the devices that should have it, and select destinations for newly enabled devices. You can stage multiple rows before applying them all in one sync commit. The same editor is available under **Skill matrix → Edit by skill** in the interactive UI.

Before applying, the editor syncs and checks that each staged cell still has its original assignments. If a staged cell changed while the editor was open, no staged changes are written. Reopen the editor to review the current assignments and stage your changes again. Changes to other cells do not block the batch.

Remote changes apply automatically when those devices next sync. If a skill is removed from every device and `delete-unassigned-skills` is enabled, SkillSync waits until every device reports the local copy gone and then removes it from the vault.

## Sync global instructions

Global instruction locations depend on the agent:

- Codex: `~/.codex/AGENTS.md`
- Cursor CLI: `~/.cursor/rules/skillsync.mdc`
- OpenCode: `~/.config/opencode/AGENTS.md`
- Claude Code: `~/.claude/CLAUDE.md`
- Grok Bot: `~/agent-data/AGENTS.md`

SkillSync stores global instructions as named profiles. Each device selects its own profile, so devices can stay different or intentionally share one.

No device wins because it installed SkillSync first. You choose which local file to import, and exact copies are shared only when their contents match.

Codex and OpenCode use `AGENTS.md`. When the Claude Code executable is installed on a device, SkillSync also links that device’s `CLAUDE.md` to the same selected profile. Devices without Claude Code do not get a `CLAUDE.md`, even if an old Claude skill target remains configured. A differing unmanaged `CLAUDE.md` is preserved for explicit resolution.

While Claude Code is installed and a profile is selected, `~/.claude/CLAUDE.md` is automatically managed and cannot be unlinked individually, including when it was linked manually. To stop global instructions sync on this device and leave standalone local copies at every linked path, run `skillsync instructions disable`. Other global paths can still be unlinked individually while another path remains linked.

Import the version already used by a device:

```bash
skillsync instructions import --name laptop --from ~/.config/opencode/AGENTS.md
```

If Codex and OpenCode on that device should use the same profile, link the other global path:

```bash
skillsync instructions link ~/.codex/AGENTS.md
```

Settings suggests unlinked provider paths when you link another instructions file. Its OpenCode suggestion follows `XDG_CONFIG_HOME`.

If an editor replaces a managed link with a regular file, automatic sync leaves that file untouched. To preserve a backup and restore the selected profile, run:

```bash
skillsync instructions enable --profile laptop --path ~/.codex/AGENTS.md --use-vault
```

For Cursor CLI, link an always-apply `.mdc` rule to the same profile:

```bash
skillsync instructions link ~/.cursor/rules/skillsync.mdc
```

SkillSync generates this rule from the selected `AGENTS.md` profile. Destinations named `skillsync.mdc` use Cursor's rule format, including paths through symlinked directories. Edit the profile and run `skillsync sync` to refresh the rule; the generated `.mdc` file cannot be imported as a profile.

If refreshing a generated Cursor rule fails, SkillSync keeps the previous complete rule until a later successful sync.

Unlinking or disabling leaves a standalone Cursor rule with the latest profile content, even if the generated file is missing. To recover a replaced Cursor link, use the `--use-vault` command above with `~/.cursor/rules/skillsync.mdc` as the path.

Cursor CLI discovers rules in parent directories, so this home-directory rule applies to projects beneath your home. For projects outside your home directory, use a project-level Cursor rule or `AGENTS.md`. `~/.cursor/AGENTS.md` is not a global instruction location.

Cursor CLI can also read skills projected to `~/.agents/skills` or `~/.codex/skills`; a separate Cursor skill target is unnecessary. See [Cursor's skill locations](https://cursor.com/docs/skills).

On a Grok Bot computer, link the selected profile to its instruction file:

```bash
skillsync instructions link ~/agent-data/AGENTS.md
```

Grok Bot does not load this file automatically. It needs a separate always-apply skill under `~/agent-data/workflows` to use the instructions.

Import another device’s different version under another name, or switch it to an existing profile:

```bash
skillsync instructions import --name workstation --from ~/.codex/AGENTS.md
skillsync instructions use laptop
```

You can also select the profile used by another device. Remote assignments apply when that device next syncs:

```bash
skillsync instructions use-device laptop --device workstation
```

Exact-content imports reuse an existing profile by default. If a device sharing a profile should diverge, fork it before editing:

```bash
skillsync instructions fork workstation-personal
```

Editing a shared profile updates every device assigned to that profile. View profiles, assignments, pending changes, and unmanaged global files with `skillsync instructions status`. SkillSync preserves replaced local paths as timestamped backups and never overwrites unmanaged replacements during background sync.

Disabling instructions on another device queues the change for its next sync. Status shows the pending disable and its last applied profile until that device applies the change.

Instruction destinations are saved as absolute paths when you import, select, enable, or link a profile, so later commands keep using the same files from any directory. For a relative destination saved by an older version, reselect its profile from the original directory to anchor the existing paths.

After a profile switch, the old profile remains available while any device still selects it or reports it as applied. SkillSync removes it only after every affected device reports the replacement was successfully applied. Disabling leaves standalone local copies, including links left by an interrupted profile switch. Replacing managed paths with an explicit `--path` or `--from` also leaves the old linked files as standalone copies. Project-specific `AGENTS.md` and `CLAUDE.md` files are not affected.

Unlinking a path leaves a standalone local copy unless another configured path reaches the same file through a directory symlink. In that case, the remaining path stays linked to the profile. If writing a standalone copy fails, the managed link is kept so the operation can be retried.

## Sync Codex plugins

Codex installs plugins per environment. SkillSync stores the selected plugin identifiers in a named profile, assigns that profile per device, and additively installs anything missing during sync.

For one universal profile containing every current and future eligible plugin on its assigned devices:

```bash
skillsync plugins import --name shared --auto-adopt
```

For a selected profile instead, choose plugins interactively:

```bash
skillsync plugins import --name selected
```

Or list them explicitly in a non-interactive environment:

```bash
skillsync plugins import --name shared \
  --plugin gmail@openai-curated,github@openai-curated
```

Assign the profile to other registered devices:

```bash
skillsync plugins use shared --device arch
skillsync plugins use shared --device devbox
skillsync plugins status
```

The other device installs missing plugins on its next sync. With auto-adoption enabled, every assigned device also contributes its durable, enabled user-managed plugins to the effective profile. Installing a plugin on the VPS therefore adds it to `shared` during the VPS's next sync, and the Mac and other assigned devices install it after they sync.

SkillSync derives this union from separate per-device reports instead of having devices rewrite one profile file. Concurrent device syncs therefore update different files. Product-managed, disabled, cached, and hosted-session-only plugins never join the union.

Device reports contain only durable user-managed plugin selectors and whether each plugin is enabled. Codex-owned packages, package versions, authentication metadata, and temporary inspection failures stay local, so routine Codex updates do not create vault commits. A failed inspection also leaves the device's last successful report unchanged. Missing inventory lists or entries without plugin identifiers count as inspection failures.

Plugin listing reports directory read failures instead of treating unreadable profiles or assignments as empty.

Automatic adoption is off unless `--auto-adopt` is supplied. Change it later with:

```bash
skillsync plugins auto-adopt shared on
skillsync plugins auto-adopt shared off
```

Existing extra plugins remain installed, and SkillSync never removes plugins. Once an automatically adopted plugin propagates to other devices, it remains part of their reported inventories; disabling auto-adoption stops future additions but does not uninstall anything already present. A disabled desired plugin stays pending; enable it from Codex's `/plugins` interface. Profiles synchronize plugin selection, while Codex continues to manage bundle versions and upgrades. Start a new Codex session after plugins are installed.

Plugin installation and connector authorization are separate. For example, SkillSync can install the Gmail plugin on a VPS, but it does not copy the Mac's Google OAuth session, API keys, cookies, or other credentials. If both Codex environments use the same account or workspace, its connector authorization may already be available; otherwise Gmail requires sign-in there. Environments that cannot complete the connector's sign-in flow may have the plugin installed but still be unable to use Gmail.

SkillSync imports durable, user-managed installs reported by `codex plugin list`. It ignores product-managed runtime plugins, marketplace caches, and plugins injected only into a hosted session. A T3 Code session may expose a plugin even when the machine's standalone Codex CLI does not consider it installed; that session provisioning is owned by the host and is not synchronized by SkillSync.

## Add and install skills

Add a local skill folder to the vault:

```bash
skillsync add ~/path/to/my-skill --name my-skill
```

Relative paths such as `skills/example` use the local folder when it exists.

Add a skill from GitHub:

```bash
skillsync add https://github.com/example-org/example-skill --skill example-skill
```

Use `--name` to override the name of one selected remote skill. For repositories containing multiple skills, select one with `--skill` first. A root skill without a frontmatter name uses the repository name.

Install a vaulted skill on this device:

```bash
skillsync install my-skill --target codex
skillsync install my-skill --target codex,claude
```

Use `--global` to record a device-level install without projecting the skill into a particular agent folder:

```bash
skillsync install my-skill --global
```

Import skills already in a supported agent folder:

```bash
skillsync import codex
skillsync import opencode
skillsync import hermes
```

Imports skip existing managed projections at configured target paths, so rerunning an import only processes standalone skills.

Manual `add` and agent imports recognize existing skills at configured targets through directory aliases and convert them to managed projections.

An unreadable source directory stops discovery before any skills are imported. Repair the reported permission or I/O error and retry. A missing agent skills directory still reports that no skills were found.

OpenCode setup detection and imports use `$XDG_CONFIG_HOME/opencode/skills` when `XDG_CONFIG_HOME` is an absolute path. Otherwise, they use `~/.config/opencode/skills`. Rerunning setup preserves paths for targets you have already configured.

When a same-named skill already exists in the vault, SkillSync keeps identical content as one skill and asks before resolving different content. Non-interactive commands skip different-content conflicts unless you choose a conflict policy explicitly. Renaming with `--conflict rename --as new-name` preserves the original source and honors `--target` and `--global` for the renamed skill.

Repeating `add` for unchanged content with the same targets preserves its registry timestamp and vault history. Adding a destination or overwriting changed content still syncs normally.

Managed links and copies are detected by their vault name, even when `SKILL.md` retains the source name. Unmanaged folders still use `SKILL.md` frontmatter when present.

## Automatic skill adoption

New targets automatically adopt new skills created inside their managed folder. For example, if Codex creates `~/.codex/skills/my-new-skill`, the next SkillSync run adds it to the vault, assigns it to Codex on that device, and replaces the standalone folder with a managed projection.

SkillSync first records the skills that already exist when a target is added. It only auto-adopts skills that appear after that baseline, so connecting an existing folder does not unexpectedly upload everything in it. Changing a target or scan path establishes a fresh baseline for the new location.

The baseline tracks each skill's path, including same-name folders and directory aliases. Removing one path does not make another pre-existing path eligible for adoption.

On upgrade from an older baseline or migration from a legacy manifest, the first scan refreshes the baseline without adopting existing folders. Later scans adopt newly created skills as usual. Target settings and instruction paths are preserved.

Automatic adoption requires a folder directly inside the target whose folder name matches the skill name. Scan and install paths can use different directory aliases for the same folder in both copy and symlink modes. Nested folders, mismatched names, and symlinked skill folders remain detected for explicit import.

Removing or moving a target cleans up its owned projections, including pending uninstalls. Skills still assigned to another target sharing the same folder remain in place. Unmanaged folders and locally edited copies stay protected.

Before moving an existing target, SkillSync checks the proposed destination for conflicts and required write access. A refused move leaves the existing target path and projections intact; fix the destination and repeat the move.

Disable auto-adoption for every target on the current device:

```bash
skillsync auto-adopt off
```

Enable it again:

```bash
skillsync auto-adopt on
```

Check the current device setting:

```bash
skillsync auto-adopt show
```

You can also override one target:

```bash
skillsync target auto-adopt codex off
skillsync target auto-adopt codex on
```

Or create a target with adoption disabled from the start:

```bash
skillsync target add codex ~/.codex/skills --no-auto-adopt
```

On a Grok Bot computer, setup detects `~/agent-data/workflows`. You can also add it manually:

```bash
skillsync target add grok ~/agent-data/workflows
```

Target names `global` and `@global` are reserved for device-global installs. If an existing target uses either name, remove it and add the same folder under a different name before assigning skills to it.

If a different skill with the same name is already in the vault, SkillSync leaves both copies untouched and reports the conflict.

Inspect local targets without adopting, applying, committing, or pushing anything:

```bash
skillsync scan
skillsync scan --json
```

## Manage another device

List registered devices and their sync state:

```bash
skillsync device list
skillsync device show workstation
```

Assign or remove a skill on another device:

```bash
skillsync install my-skill --device workstation --target codex
skillsync uninstall my-skill --device workstation --target codex
```

This changes the desired assignment in the private vault; it does not require SSH. If the other device is offline, the change remains pending. Its SkillSync service pulls and applies the assignment the next time it runs.

The vault keeps cross-device assignments separate from device-reported local state:

```text
skills/          canonical skill folders
devices/         desired assignments, editable from any connected device
state/           local targets and inventory reported by each device
globals/agents/  named global instruction profiles
globals/assignments/  each device's selected instruction profile
plugins/profiles/  named Codex plugin selections
plugins/assignments/  each device's selected plugin profile
plugins/state/  installed, missing, disabled, and applied plugin state
registry.json    generated skill index
vault.json       vault-wide settings
```

This separation lets one device safely edit another device’s assignments without taking ownership of the other device’s paths, inventory, or applied status.

Malformed device assignments or inventories stop sync with an error naming the state file. An unreadable device inventory also stops cleanup of skills and instruction profiles.

## Skill packs

Run `skillsync groups` to regenerate pack manifests and group pages from `groups.json`. Packs removed from the configuration, or left without available skills, disappear from the generated outputs. Cleanup preserves unmanaged files and edited group pages.

`groups.json` must be an object. Its optional `packs` field maps pack names to arrays of skill names or objects with a required `skills` array. Missing `skills` is an error; use `"skills": []` for an intentionally empty pack. Invalid configuration stops generation before commits or generated-file changes; use `"packs": {}` to remove every generated pack explicitly.

`skillsync pack list` reads existing pack manifests without initializing or changing the vault. Run `skillsync groups` to apply changes from `groups.json` before listing or installing updated packs.

## Remove skills

Remove a skill from one device:

```bash
skillsync uninstall my-skill
```

With no destination options, uninstall removes all assignments for that skill on the current device, including global installs. Use `--device id` or `-d id` to select another device, `--target codex,claude` or `-t codex,claude` to select targets, or `--global` to remove only the global assignment. Value-taking options require a non-empty value rather than another flag, and an explicit target list must contain at least one name. Uninstall rejects missing values and empty target lists before vault initialization, sync, or removal.

Use **Sync selected from vault** in **Installed on this device** to update skills at `<install-folder>/<skill-name>`, including standalone folders left after a refused install. SkillSync asks for confirmation and retains a recoverable backup before replacement. Nested or differently named detected folders are reported as skipped and stay unchanged; confirmed uninstall still supports those folders.

In the **Installed on this device** menu and `skillsync scan`, a local skill is classified as managed only at its configured projection path with a vault-owned symlink or copy marker, including when its containing directory has a symlink alias. Same-named standalone folders and folders left after a refused install remain unmanaged. Uninstall asks for confirmation before removing standalone folders. Standalone removal skips folders outside the target's install folder, the install folder itself, and symlinked paths.

Standalone removal checks directory permissions before deleting files or changing that skill's assignments. If a folder or its parent is read-only, make it writable and retry; SkillSync does not change those permissions automatically.

Selected vault updates and confirmed standalone removal also accept different scan and install aliases of the same physical folder. Updates still require confirmation before replacing a standalone folder and preserve its contents in a recoverable backup.

Delete it from the vault and every device:

```bash
skillsync delete my-skill
```

After confirmation, deletion pulls the vault before removing the skill and its assignments, including assignments pushed by other devices since this checkout last synced. If the pull fails, deletion stops before removing the skill or changing assignments. Deleting one skill preserves other skills' target and global assignments, including assignments in legacy device manifests.

Vault deletion validates every desired device document before rewriting assignments. If a document is malformed, repair the reported file and retry.

Explicit deletion and automatic cleanup support imported read-only directories, including the skill root. They retain the complete skill with its original permissions under Git's private `skillsync/deleted-skills/` directory, or `.skillsync-local/deleted-skills/` in a plain vault. These backups stay on this device, are not indexed as skills, and are not automatically pruned. With Git metadata on another filesystem, deletion stages beside the skill and copies the backup into Git metadata before updating assignments and the registry.

If a metadata write fails, deletion restores the skill and leaves its registry entry intact. Assignments already cleared remain cleared. Repair the reported error and retry deletion to finish.

By default, unused skills remain in the vault. To clean them up automatically during full syncs:

```bash
skillsync policy set delete-unassigned-skills on
```

A full `skillsync sync` then removes a vault skill only when it has no assignment on any device and no device reports a detected local copy. Existing unassigned skills are included, while detected local skills are protected. Changes made for another device remain protected until that device syncs and reports its updated local state.

Permission and I/O errors during scanning stop sync before it replaces the saved inventory or deletes unused skills.

## Sync and status

Run a sync immediately:

```bash
skillsync sync
```

Sync leaves `registry.json` untouched when its entries and metadata are unchanged.

If another device pushes first, sync pulls its changes, validates and applies them locally, and updates the device report before retrying the push once. A second rejection stops sync with an error.

When a remote deletion leaves local cache files in a skill folder, sync moves those remnants into Git's private `skillsync/deleted-skills/` directory before validating the vault and removing stale projections. These backups stay on this device and are never synced.

If preserving those files fails, repair the reported storage or permission error and run sync again. Sync records each pull's starting Git revision privately and saves the identities of pending remnant folders before moving them. Retries retain unfinished backups across later pulls without moving a new folder created at a completed backup's old name.

If the filesystem cannot prove a folder's identity after an interrupted backup, sync keeps the recovery state and reports the affected folder. Move that folder outside the vault to preserve its contents, then run sync again. This can occur on filesystems that do not provide stable creation times.

Sync stops if Git leaves unresolved conflicts, including conflicts while restoring local edits after a pull. Resolve and stage the affected files before retrying. `--no-pull` does not bypass this check.

Preview local skill projection changes without pulling or writing:

```bash
skillsync sync --dry-run
```

SkillSync checks every destination before applying the plan. It backs up changed skill projections in local Git metadata and restores them if the apply or a later local reconciliation step fails. Copy-mode projections track deployed contents and executable permissions. If a managed copy was edited locally, sync stops instead of overwriting it. After reviewing those edits, discard them explicitly with:

```bash
skillsync sync --discard-local-changes
```

Copies created by older versions refresh once to record executable permissions when their contents have not been edited. That refresh applies the vault's executable bits, since older copies did not record local permission edits.

Copy-mode updates, removal, and rollback support read-only skill directories, including the skill root. Deployed copies and retained backups preserve their directory modes.

New backups of replaced local folders preserve nested symlinks exactly, including relative paths. Rollback preserves those link targets when restoring the folder.

Repairing a projection recovery error lets the next daemon cycle retry without a restart.

Projection apply and rollback share a local lock. A competing live writer is refused; an abandoned writer's lock is recovered automatically before applying. Lock cleanup removes only its own lease, so concurrent recovery cannot remove a newer writer's lock. Locks from older releases remain readable, including the one-minute grace period for a writer still starting. Restart an older daemon when upgrading so all writers use the same locking protocol.

Restore the most recent successful local projection apply in an emergency:

```bash
skillsync rollback
```

Rollback restores files only. It does not change assignments or target settings.

Validate vault structure, registry hashes, JSON files, symlinks, and common credential formats without changing the vault:

```bash
skillsync check
```

`registry.json` and `vault.json` must contain objects with the supported fields. Values such as `null` or `false` fail validation.

Inspect the current configuration:

```bash
skillsync status
skillsync installed
skillsync installed --device workstation
```

The background service syncs when it starts and then checks every 120 seconds. It rereads local configuration before each sync, so changing the selected vault or device takes effect on the next cycle. If the updated configuration is invalid, that cycle reports an error and retries after repair. It uses a macOS LaunchAgent or a Linux systemd user service.

Registry hashes exclude untracked files ignored by Git, including filenames with Unicode characters, so local generated files do not cause repeated sync commits across devices. Tracked files still count even when an ignore rule matches them. Copy-mode overwrite protection continues to check every deployed file, including ignored files. The first sync after upgrading may correct an existing hash once; upgrade every device to prevent older versions from restoring it.

Verify it on macOS:

```bash
launchctl print gui/$(id -u)/dev.skillsync.daemon
```

Verify it on Linux:

```bash
systemctl --user status skillsync.service --no-pager
```

## Command reference

```text
skillsync                 Open TUI
skillsync setup [--name skills] [--repo owner/repo|url] [--path path] [--yes]
skillsync connect <owner/repo|url> [--path path]
skillsync status
skillsync list
skillsync installed [--device id]
skillsync matrix [--edit]
skillsync instructions status
skillsync instructions profiles
skillsync instructions import [--name profile] [--from path] [--to path] [--separate]
skillsync instructions use <profile> [--device id] [--path path]
skillsync instructions use-device <source-device> [--device target-device]
skillsync instructions fork [profile]
skillsync instructions link <path>
skillsync instructions unlink <path>
skillsync instructions enable [--profile profile] [--path path] [--from-local|--use-vault]
skillsync instructions disable [--device id]
skillsync plugins status
skillsync plugins profiles
skillsync plugins show <profile>
skillsync plugins import --name <profile> [--plugin plugin@marketplace] [--auto-adopt|--no-auto-adopt]
skillsync plugins use <profile> [--device id]
skillsync plugins auto-adopt <profile> <on|off>
skillsync device list
skillsync device show <id>
skillsync groups [--summary]
skillsync pack list
skillsync pack show <pack>
skillsync pack install <pack> [--target targets] [--global]
skillsync add <skill-folder-or-git-url> [--name name] [--skill name] [--target targets] [--global] [--conflict skip|use-vault|overwrite-vault|rename]
skillsync import <hermes|codex|opencode> [--conflict skip|use-vault|overwrite-vault|rename]
skillsync install <skill> [--device id] [--target targets] [--global]
skillsync uninstall <skill> [--device id] [--target targets] [--global]
skillsync delete <skill> [--yes]
skillsync target add <name> <path> [--mode symlink|copy] [--scan-path path] [--no-auto-adopt]
skillsync target remove <name>
skillsync target auto-adopt <name> <on|off>
skillsync auto-adopt [show|on|off]
skillsync policy show
skillsync policy set delete-unassigned-skills <on|off>
skillsync scan [--json]
skillsync sync [--dry-run] [--no-pull] [--discard-local-changes]
skillsync rollback
skillsync check
skillsync service install
skillsync doctor
skillsync daemon
```

## Safety

- SkillSync will not silently overwrite an unmanaged local folder.
- SkillSync refuses to overwrite or remove a locally edited managed copy unless you explicitly discard the edits.
- Skill projection applies restore their previous state after a failure.
- Failed target moves or removals restore the previous private paths, device reports, assignments, and managed projections. Fix the reported write error before retrying.
- Vault checks reject symlinks, malformed JSON, stale registry entries, reserved ownership markers, and common credential formats. Pushes also check unpushed commit additions so removing a credential in a later commit does not silently publish it.
- Symlinked content outside a configured target is not auto-adopted.
- Different same-name skills require explicit conflict resolution.
- Vault imports stage and validate the replacement before moving the existing skill. Failed replacements restore the original. Explicit overwrites keep the original under Git's private `skillsync/imports/` directory, or `.skillsync-local/imports/` in a plain vault. If Git metadata is on another filesystem, imports use temporary Git-ignored staging beside the destination and copy the backup into Git metadata before saving the registry. These local backups are not indexed as skills or synced to other devices.
- Plugin sync is additive and never copies connector credentials.
- Vault deletion is explicit unless you enable the last-assignment deletion policy.
- Your skills and device configuration stay in the private GitHub vault you control.

See [CONTRIBUTING.md](CONTRIBUTING.md) to work on SkillSync itself and [SECURITY.md](SECURITY.md) to report a vulnerability.
