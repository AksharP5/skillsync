# SkillSync

Local-first skill manager for AI agent skills.

SkillSync uses a private GitHub repo as your cloud vault, then keeps selected skills linked into local agent skill folders on each device. Install it once with npm, connect it to your vault, and use the `skillsync` command anywhere.

## Quick start

Install the CLI:

```bash
npm install -g @akshar5/skillsync
```

Connect this device to an existing private skills vault:

```bash
skillsync setup --repo AksharP5/skills
```

Add a local skill folder to the vault:

```bash
skillsync add ~/path/to/my-skill --skill my-skill
```

Add a skill from a GitHub repository:

```bash
skillsync add https://github.com/example-org/example-skill --skill example-skill
```

Install a vaulted skill into a local agent target:

```bash
skillsync target add codex ~/.codex/skills
skillsync install my-skill --target codex
```

Open the interactive UI:

```bash
skillsync
```

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
```

User-owned files are the skill folders under `skills/`. SkillSync owns `registry.json` and `devices/*.json`.

Local target folders are per-device. For example, one laptop can install a skill into `~/.codex/skills`, while another can install the same vault skill into a different agent folder.

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
skillsync setup --repo AksharP5/skills
```

Or create/select a vault repo under your GitHub account:

```bash
skillsync setup --name skills
```

If you run plain `skillsync setup` in an interactive terminal, it asks for the repo name and defaults to `skills`. `setup --name` creates `OWNER/skills` as a private GitHub repo if it does not exist. If it exists, SkillSync verifies it is private before using it.

You can also run commands without a global install:

```bash
npx @akshar5/skillsync setup --repo AksharP5/skills
npx @akshar5/skillsync add https://github.com/example-org/example-skill --skill example-skill
```

If an older SkillSync version failed with `git@github.com: Permission denied (publickey)`, update the CLI and rerun setup:

```bash
npm install -g @akshar5/skillsync@latest
skillsync setup --repo AksharP5/skills
```

## Common workflows

List available skills:

```bash
skillsync list
```

Check current vault/device state:

```bash
skillsync status
```

Add local agent targets:

```bash
skillsync target add codex ~/.codex/skills
skillsync target add claude ~/.claude/skills
skillsync target add hermes ~/.hermes/skills/personal --scan-path ~/.hermes/skills
```

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
skillsync uninstall my-skill
```

Sync the vault and reapply local links:

```bash
skillsync sync
```

Scan configured target folders for already-installed local skills:

```bash
skillsync scan
```

## Commands

```bash
skillsync setup
skillsync setup --repo owner/repo
skillsync setup --name skills
skillsync
skillsync status
skillsync list
skillsync add <skill-folder-or-git-url> --skill <name>
skillsync add https://github.com/example-org/example-skill --skill example-skill
skillsync import hermes
skillsync install <skill> --target codex
skillsync uninstall <skill>
skillsync delete <skill>
skillsync target add codex ~/.codex/skills
skillsync target add hermes ~/.hermes/skills/personal --scan-path ~/.hermes/skills
skillsync scan
skillsync sync
skillsync service install
skillsync daemon
```

## Removal model

- `skillsync uninstall <skill>` removes the skill from the current device only.
- `skillsync delete <skill>` removes the skill from the vault and all device manifests.

## Detected versus managed skills

`installed` skills are SkillSync-managed projections into a target folder. `detected` skills are already present in a local agent's skill tree, such as bundled Hermes skills under `~/.hermes/skills`.

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
