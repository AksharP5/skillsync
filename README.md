# SkillSync

Keep the same AI agent skills available across all of your devices.

SkillSync stores one canonical copy of each skill in a private GitHub repository, projects the skills you choose into Codex, Claude, OpenCode, Hermes, or any custom skill folder, and keeps every device in sync in the background.

## Start with an agent

Paste this into any terminal-capable coding agent:

```text
Set up SkillSync completely on this device.

1. Check for Node.js 20 or newer, Git, GitHub CLI, and an authenticated `gh auth status`. Stop and tell me what is missing before continuing.
2. Ask whether I already have a SkillSync vault. If I do, run `npx -y @akshar5/skillsync@latest setup --repo OWNER/REPO`. Otherwise, run `npx -y @akshar5/skillsync@latest setup`.
3. Let setup detect my Codex, OpenCode, Claude Code, and Hermes skill folders. Show me any existing standalone skills and ask which ones I want to import. Do not import or resolve differing skill content without asking me.
4. Install the persistent CLI with `npm install -g @akshar5/skillsync@latest`, then run `skillsync service install`.
5. Ask whether I want to sync global agent instructions. If I do, inspect my existing Codex and OpenCode AGENTS.md files, import the version I choose, and link each installed provider's global path to that profile. Only manage CLAUDE.md when Claude Code is installed. Preserve any differing unmanaged file.
6. Verify `skillsync doctor`, `skillsync status`, `skillsync matrix`, `skillsync instructions status`, and the background service. Report the vault, detected targets, auto-adoption settings, instruction profile, service state, and anything that still needs my decision.
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

Setup detects Codex, Claude Code, OpenCode, and Hermes folders. Add a custom skill folder only when needed:

```bash
skillsync target add my-agent ~/.config/my-agent/skills
```

Then install the background service:

```bash
skillsync service install
```

Repeat the install, existing-vault setup, and service steps on each device.

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

Remote changes apply automatically when those devices next sync. If a skill is removed from every device and `delete-unassigned-skills` is enabled, SkillSync waits until every device reports the local copy gone and then removes it from the vault.

## Sync global instructions

Global instruction locations depend on the agent:

- Codex: `~/.codex/AGENTS.md`
- OpenCode: `~/.config/opencode/AGENTS.md`
- Claude Code: `~/.claude/CLAUDE.md`

SkillSync stores global instructions as named profiles. Each device selects its own profile, so devices can stay different or intentionally share one.

No device wins because it installed SkillSync first. You choose which local file to import, and exact copies are shared only when their contents match.

Codex and OpenCode use `AGENTS.md`. When the Claude Code executable is installed on a device, SkillSync also links that device’s `CLAUDE.md` to the same selected profile. Devices without Claude Code do not get a `CLAUDE.md`, even if an old Claude skill target remains configured. A differing unmanaged `CLAUDE.md` is preserved for explicit resolution.

Import the version already used by a device:

```bash
skillsync instructions import --name laptop --from ~/.config/opencode/AGENTS.md
```

If Codex and OpenCode on that device should use the same profile, link the other global path:

```bash
skillsync instructions link ~/.codex/AGENTS.md
```

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

After a profile switch, the old profile remains available while any device still selects it or reports it as applied. SkillSync removes it only after every affected device reports the replacement was successfully applied. Disabling leaves standalone local copies. Project-specific `AGENTS.md` and `CLAUDE.md` files are not affected.

## Add and install skills

Add a local skill folder to the vault:

```bash
skillsync add ~/path/to/my-skill --name my-skill
```

Add a skill from GitHub:

```bash
skillsync add https://github.com/example-org/example-skill --skill example-skill
```

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

When a same-named skill already exists in the vault, SkillSync keeps identical content as one skill and asks before resolving different content. Non-interactive commands skip different-content conflicts unless you choose a conflict policy explicitly.

Git imports retain their repository, ref, commit, and skill subpath. Check tracked skills without changing the vault, then apply one reviewed update explicitly:

```bash
skillsync update --check
skillsync update example-skill
skillsync update example-skill --apply
```

## Audit the active catalog

Validate Agent Skills metadata, find duplicate or conflicting copies across configured targets, and estimate the description tokens loaded by each active catalog:

```bash
skillsync audit
skillsync audit --json
```

`skillsync doctor` includes the catalog summary. Audit errors cover malformed frontmatter, non-portable names, directory/name mismatches, missing descriptions, and specification limits. Longer-but-valid descriptions and oversized skill bodies are warnings.

Consolidate byte-identical copies across configured targets into one vault skill and managed projections. Cleanup previews by default and leaves same-name conflicts untouched:

```bash
skillsync cleanup
skillsync cleanup --apply
```

## Reconcile an exact skill pack

Pack application previews changes by default. `--exact` removes SkillSync assignments for skills outside the pack on only the selected targets; unmanaged local folders and assignments on other targets remain untouched.

```bash
skillsync pack apply core --target codex,claude --exact
skillsync pack apply core --target codex,claude --exact --apply
```

## Automatic skill adoption

New targets automatically adopt new skills created inside their managed folder. For example, if Codex creates `~/.codex/skills/my-new-skill`, the next SkillSync run adds it to the vault, assigns it to Codex on that device, and replaces the standalone folder with a managed projection.

SkillSync first records the skills that already exist when a target is added. It only auto-adopts skills that appear after that baseline, so connecting an existing folder does not unexpectedly upload everything in it.

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

If a different skill with the same name is already in the vault, SkillSync leaves both copies untouched and reports the conflict.

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
registry.json    generated skill index
vault.json       vault-wide settings
```

This separation lets one device safely edit another device’s assignments without taking ownership of the other device’s paths, inventory, or applied status.

## Remove skills

Remove a skill from one device:

```bash
skillsync uninstall my-skill
```

Delete it from the vault and every device:

```bash
skillsync delete my-skill
```

By default, unused skills remain in the vault. To clean them up automatically during full syncs:

```bash
skillsync policy set delete-unassigned-skills on
```

A full `skillsync sync` then removes a vault skill only when it has no assignment on any device and no device reports a detected local copy. Existing unassigned skills are included, while detected local skills are protected. Changes made for another device remain protected until that device syncs and reports its updated local state.

## Sync and status

Run a sync immediately:

```bash
skillsync sync
```

Inspect the current configuration:

```bash
skillsync status
skillsync installed
skillsync installed --device workstation
```

The background service syncs when it starts and then checks every 120 seconds. It uses a macOS LaunchAgent or a Linux systemd user service.

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
skillsync audit [--json]
skillsync cleanup [--apply]
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
skillsync device list
skillsync device show <id>
skillsync groups [--summary]
skillsync pack list
skillsync pack show <pack>
skillsync pack install <pack> [--target targets] [--global]
skillsync pack apply <pack> --target targets [--exact] [--apply]
skillsync add <skill-folder-or-git-url> [--name name] [--skill name] [--target targets] [--global] [--conflict skip|use-vault|overwrite-vault|rename]
skillsync import <hermes|codex|opencode> [--conflict skip|use-vault|overwrite-vault|rename]
skillsync install <skill> [--device id] [--target targets] [--global]
skillsync uninstall <skill> [--device id] [--target targets] [--global]
skillsync delete <skill> [--yes]
skillsync update [skill] [--check] [--apply]
skillsync target add <name> <path> [--mode symlink|copy] [--scan-path path] [--no-auto-adopt]
skillsync target remove <name>
skillsync target auto-adopt <name> <on|off>
skillsync auto-adopt [show|on|off]
skillsync policy show
skillsync policy set delete-unassigned-skills <on|off>
skillsync scan
skillsync sync
skillsync service install
skillsync doctor
skillsync daemon
```

## Safety

- SkillSync will not silently overwrite an unmanaged local folder.
- Symlinked content outside a configured target is not auto-adopted.
- Different same-name skills require explicit conflict resolution.
- Vault deletion is explicit unless you enable the last-assignment deletion policy.
- Your skills and device configuration stay in the private GitHub vault you control.

See [CONTRIBUTING.md](CONTRIBUTING.md) to work on SkillSync itself and [SECURITY.md](SECURITY.md) to report a vulnerability.
