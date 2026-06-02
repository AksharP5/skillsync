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

## Commands

```bash
skillsync setup
skillsync
skillsync add <skill-folder>
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
