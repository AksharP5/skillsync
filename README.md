# SkillSync

Local-first skill manager for AI agent skills.

SkillSync uses a private GitHub repo as your cloud vault, then keeps selected skills linked into local agent skill folders on each device. Install it once with npm, connect it to your vault, and use the `skillsync` command anywhere.

The public SkillSync source and npm package are separate from your skill vault. Your skills, device assignments, and detected local inventory remain in a private repository that you own.

## Quick start

Install the CLI:

```bash
npm install -g @akshar5/skillsync
```

Connect this device to an existing private skills vault:

```bash
skillsync setup --repo OWNER/skills
```

Add a local skill folder to the vault:

```bash
skillsync add ~/path/to/my-skill --skill my-skill
```

Add a skill from a GitHub repository:

```bash
skillsync add https://github.com/example-org/example-skill --skill example-skill
```

Install a vaulted skill into a local agent target, or mark it installed globally on this device without projecting into a specific agent folder:

```bash
skillsync target add codex ~/.codex/skills
skillsync install my-skill --target codex
skillsync install my-skill --global
```

Open the interactive UI:

```bash
skillsync
```

In the interactive UI, use arrow keys to move, Space to toggle checklist items, Enter to apply, and Esc to go back.

## Requirements

- Node.js 20 or newer
- Git
- GitHub CLI (`gh`) authenticated with `gh auth login`
- A private GitHub repo for the skills vault

## What it manages

Vault repo layout:

```text
skills/
  some-skill/
    SKILL.md
registry.json        # generated, do not edit
devices/*.json       # generated, do not edit
vault.json           # generated vault-wide policies
```

User-owned files are the skill folders under `skills/`. SkillSync owns `registry.json`, `vault.json`, and `devices/*.json`.

Local target folders are per-device. For example, one laptop can install a skill into `~/.codex/skills`, while another can install the same vault skill into a different agent folder.

Each device manifest records:

- configured agent targets and their local paths;
- desired skill assignments;
- the desired assignment generation;
- the most recent generation that device successfully applied;
- detected local skills.

An assignment made from another device is pending until the target device's daemon pulls and applies that generation.

## Install on a new device

Install prerequisites on macOS:

```bash
brew install gh git node
gh auth login
```

SkillSync clones vault repos over HTTPS using your GitHub CLI authentication, so a GitHub SSH key is not required.

Install SkillSync:

```bash
npm install -g @akshar5/skillsync
```

Connect to an existing vault:

```bash
skillsync setup --repo OWNER/skills
```

Install the background service so assignments and skill updates apply automatically:

```bash
skillsync service install
```

Repeat those steps once on every device. Each device registers its own ID and local agent targets in the same private vault.

Or create/select a vault repo interactively:

```bash
skillsync setup
```

If you run plain `skillsync setup` in an interactive terminal, it first asks which vault type to use:

- Choose `Use an existing GitHub repo`, then enter a repo like `OWNER/skills`.
- Choose `Create or use OWNER/<name>`, then enter a repo name like `skills`.

`setup --name skills` is the non-interactive form of the second option. It creates `OWNER/skills` as a private GitHub repo if it does not exist. If it exists, SkillSync verifies it is private before using it.

You can also run commands without a global install:

```bash
npx @akshar5/skillsync setup --repo OWNER/skills
npx @akshar5/skillsync add https://github.com/example-org/example-skill --skill example-skill
```

If an older SkillSync version failed with `git@github.com: Permission denied (publickey)`, update the CLI and rerun setup:

```bash
npm install -g @akshar5/skillsync@latest
skillsync setup --repo OWNER/skills
```

## Common workflows

List available skills:

```bash
skillsync list
```

Browse and install multiple vault skills at once:

```bash
skillsync
```

Choose `Browse/install skills`, press Space to select every skill you want installed on this device, then press Enter to apply the changes. When prompted for destinations, choose `global` for a device-level install that does not create a Codex/OpenCode/etc. projection, or choose one or more configured agent targets.

View skills installed on this device:

```bash
skillsync installed
```

View another registered device:

```bash
skillsync device list
skillsync device show archlinux
skillsync installed --device archlinux
```

Assign or remove a skill on another device:

```bash
skillsync install my-skill --device archlinux --target codex
skillsync uninstall my-skill --device archlinux --target codex
```

Remote assignment changes update desired state in the private vault. They do not require SSH access. If the target device is offline, the assignment remains pending until its SkillSync service next runs.

The interactive UI exposes the same workflow: choose **Devices**, select a device, then toggle skills or edit one skill's exact destinations.

In the interactive UI, choose `Installed on this device` to see both SkillSync-managed installs and detected local skills. From there you can sync vault-backed skills or uninstall selected skills from the current device. Local-only detected folders require confirmation before SkillSync deletes them.

The non-interactive `skillsync installed` command also prints concrete managed projection paths, so target-backed installs are visible as symlinks/copies, for example:

```text
- bog-hyperframes  [managed: codex | in vault]
  -> codex: ~/.codex/skills/bog-hyperframes -> ~/.skillsync/repo/skills/bog-hyperframes
```

If a managed projection is missing, it is shown as missing and `skillsync sync` will recreate it.

Check current vault/device state:

```bash
skillsync status
```

Add local agent targets:

```bash
skillsync target add codex ~/.codex/skills
skillsync target add opencode ~/.config/opencode/skills
skillsync target add claude ~/.claude/skills
skillsync target add hermes ~/.hermes/skills/personal --scan-path ~/.hermes/skills
```

Import existing local agent skills into the vault:

```bash
skillsync import hermes
skillsync import codex
skillsync import opencode
```

`import` scans the default skill folder for that agent (`~/.hermes/skills`, `~/.codex/skills`, or `~/.config/opencode/skills`), copies each `SKILL.md` folder into the vault, and pushes the vault update. If the local folder is exactly the configured target path for that agent, SkillSync also replaces it with a vault-managed projection so future syncs keep it current.

Add a skill folder to the vault:

```bash
skillsync add ~/Developer/skills/my-skill --skill my-skill
```

Add from a GitHub repo:

```bash
skillsync add https://github.com/example-org/example-skill --skill example-skill
```

If the source repo contains multiple skills, omit `--skill` in an interactive terminal and SkillSync will ask which ones to add. Add `--target codex` or `--target '*'` to install immediately after importing:

```bash
skillsync add https://github.com/example-org/example-skill --target codex
skillsync add https://github.com/example-org/example-skill --target '*'
```

Install or uninstall a vaulted skill on this device:

```bash
skillsync install my-skill --target codex
skillsync install my-skill --global
skillsync uninstall my-skill
skillsync uninstall my-skill --global
```

Sync the vault and reapply local links:

```bash
skillsync sync
```

If an installed skill changes in the vault, `skillsync sync` pulls the vault and reapplies local projections. Symlink targets point at the current vault copy automatically; copy targets are refreshed when links are reapplied. Device-global installs are counted as installed on the device but do not create or scan an agent folder. Vault skills that already exist locally but were not installed by SkillSync are shown as local vault-backed skills and checked in Browse/install. Sync them from the `Installed on this device` screen to replace the same-named local folder with the vault-managed projection.

Scan configured target folders for already-installed local skills:

```bash
skillsync scan
```

## Automatically adopt newly created local skills

By default, SkillSync detects new local skills but does not upload them automatically. Enable automatic import for a target when every newly created skill in that managed folder should be adopted into the vault:

```bash
skillsync target auto-import codex on
```

Enabling the setting first baselines existing local skills. Only skills detected after that baseline are automatically adopted. This prevents an initial opt-in from uploading every pre-existing Codex, Claude, Hermes, or OpenCode skill.

For each newly detected skill, SkillSync:

1. verifies that the folder contains `SKILL.md`;
2. copies it into the canonical vault;
3. assigns it to the source target;
4. replaces the standalone folder with a SkillSync-managed projection;
5. commits and pushes the meaningful skill addition.

If a different skill with the same name already exists in the vault, automatic import leaves both copies untouched and reports a conflict for explicit resolution.

Disable automatic import with:

```bash
skillsync target auto-import codex off
```

## Delete skills after their last uninstall

The safe default keeps unassigned skills in the vault. A vault owner can enable event-driven deletion:

```bash
skillsync policy set delete-unassigned-skills on
```

When enabled, removing a skill's final assignment deletes that skill from the vault. Removing one target while another device or target still uses the skill does not delete it.

This policy is deliberately not a garbage-collection sweep. Enabling it does not delete skills that were already unassigned. It only applies when an uninstall or target-removal operation transitions a particular skill from at least one assignment to zero.

Check the current policy:

```bash
skillsync policy show
```

## Commands

```bash
skillsync setup
skillsync setup --repo owner/repo
skillsync setup --name skills
skillsync
skillsync status
skillsync list
skillsync installed [--device id]
skillsync device list
skillsync device show <id>
skillsync add <skill-folder-or-git-url> --skill <name> [--target target] [--global] [--conflict skip|use-vault|overwrite-vault|rename]
skillsync add https://github.com/example-org/example-skill --skill example-skill
skillsync import <hermes|codex|opencode> [--conflict skip|use-vault|overwrite-vault|rename]
skillsync install <skill> [--device id] --target codex
skillsync install <skill> --global
skillsync uninstall <skill> [--device id] [--target codex] [--global]
skillsync delete <skill>
skillsync target add codex ~/.codex/skills [--auto-import]
skillsync target add opencode ~/.config/opencode/skills
skillsync target add hermes ~/.hermes/skills/personal --scan-path ~/.hermes/skills
skillsync target auto-import codex <on|off>
skillsync policy show
skillsync policy set delete-unassigned-skills <on|off>
skillsync scan
skillsync sync
skillsync service install
skillsync daemon
```

## Removal model

- `skillsync uninstall <skill>` removes the skill from the current device, including any device-global marker and SkillSync-managed target projections.
- `skillsync uninstall <skill> --global` removes only the device-global marker.
- With `delete-unassigned-skills` enabled, an uninstall or target removal that removes the final assignment also removes the canonical vault skill.
- `skillsync delete <skill>` removes the skill from the vault and all device manifests.

## Skill names

Skill names are vault-wide identifiers. Installing `my-skill` on two devices means both devices refer to the same vault skill. You can install the same skill on many devices, but you should not use the same name for two different skills in one vault.

When `skillsync add` or `skillsync import` sees a same-name skill:

- identical content: it keeps the single vault copy. If the local folder is in a configured target path, SkillSync replaces the local folder with the vault-managed link/copy.
- different content: it shows a diff summary and asks whether to keep the vault version, overwrite the vault with the local/source version, save the local/source version under a different name, or skip.

For scripts/non-interactive runs, different same-name conflicts are skipped by default. Override with:

```bash
skillsync import codex --conflict use-vault
skillsync import codex --conflict overwrite-vault
skillsync import codex --conflict rename --as my-skill-mac
```

## Detected versus managed skills

`managed` skills are SkillSync-owned projections into a target folder. `detected` skills are already present in a local agent's skill tree, such as bundled Hermes skills under `~/.hermes/skills` or skills you installed before setting up SkillSync.

For Hermes, use a separate scan path so SkillSync installs personal synced skills into `~/.hermes/skills/personal` while still showing the full Hermes skill inventory from `~/.hermes/skills`:

```bash
skillsync target add hermes ~/.hermes/skills/personal --scan-path ~/.hermes/skills
skillsync scan
```

## Auto-sync

`skillsync service install` installs a background service:

- macOS: LaunchAgent
- Linux: systemd user service

The service periodically pulls/pushes the GitHub vault and reapplies symlinks.

The generated service launches the stable `skillsync` executable from `PATH`, so npm or pnpm upgrades do not leave it pinned to an old content-addressed package directory. Run `skillsync service install` again if the executable location itself changes.

The daemon syncs immediately when it starts, then every 120 seconds. macOS LaunchAgents normally start after login. Linux systemd user services start with the user's service manager; headless systems may require lingering if they must sync before login.

On macOS, install and verify the LaunchAgent:

```bash
skillsync service install
launchctl print gui/$(id -u)/dev.skillsync.daemon
```

Restart the LaunchAgent manually when troubleshooting:

```bash
launchctl kickstart -k gui/$(id -u)/dev.skillsync.daemon
```

On Linux, verify the systemd user service:

```bash
systemctl --user status skillsync.service --no-pager
```

## Development

Clone and test locally:

```bash
git clone https://github.com/AksharP5/skillsync.git
cd skillsync
npm install
npm test
npm pack --dry-run
```

The npm package name is `@akshar5/skillsync` because `skillsync` is already taken on npm. The installed command is still `skillsync`.

Future releases are managed by Release Please and GitHub Actions. Use conventional commits:

- `fix:` creates a patch release.
- `feat:` creates a minor release.
- `feat!:` or `BREAKING CHANGE:` creates a major release.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development workflow and
[SECURITY.md](SECURITY.md) for private vulnerability reporting. SkillSync is
available under the [MIT License](LICENSE).
