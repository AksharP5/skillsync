# SkillSync

Local-first skill manager for AI agent skills.

SkillSync uses a private GitHub repo as your cloud vault, then keeps selected skills linked into local agent skill folders on each device.

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

## Install on another device

Install SkillSync from npm:

```bash
npm install -g @akshar5/skillsync
```

Then connect to your private skills vault:

```bash
skillsync setup --repo AksharP5/skills
```

You can also run one-off commands with `npx`:

```bash
npx @akshar5/skillsync setup --repo AksharP5/skills
npx @akshar5/skillsync add https://github.com/example-org/example-skill --skill example-skill
```

On a new macOS device, install the system prerequisites first:

```bash
brew install gh git node
gh auth login
skillsync setup --repo AksharP5/skills
```

Or create/select a different private vault repo name:

```bash
skillsync setup --name my-skills
```

If you run plain `skillsync setup` in an interactive terminal, it asks for the repo name and defaults to `skills`. `setup --name` creates `OWNER/my-skills` as a private GitHub repo if it does not exist. If it exists, SkillSync verifies it is private before using it.

## Commands

```bash
skillsync setup
skillsync
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
```

## Removal model

- `skillsync uninstall <skill>` removes the skill from the current device only.
- `skillsync delete <skill>` removes the skill from the vault and all device manifests.

## Add from GitHub

You can import a skill directly from a GitHub repo into your private vault:

```bash
skillsync add https://github.com/example-org/example-skill --skill example-skill
```

If the repo has multiple skills, omit `--skill` in an interactive terminal and SkillSync will ask which ones to add. Add `--target codex` or `--target '*'` to install it on the current device immediately after importing.

## Publishing to npm

The first public version is published as `@akshar5/skillsync`. Future releases are managed by Release Please and GitHub Actions.

Use conventional commits to drive release versions:

- `fix:` creates a patch release.
- `feat:` creates a minor release.
- `feat!:` or `BREAKING CHANGE:` creates a major release.

When the release PR is merged, GitHub Actions runs tests and publishes to npm through trusted publishing.

Manual checks before merging release-related changes:

```bash
npm install
npm test
npm pack --dry-run
```

The package name is `@akshar5/skillsync` because `skillsync` is already taken on npm. The installed command is still `skillsync`.

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
