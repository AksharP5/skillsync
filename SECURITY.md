# Security Policy

## Supported versions

Security fixes are provided for the latest published version of SkillSync.

## Reporting a vulnerability

Please use GitHub's private **Report a vulnerability** flow for this repository. Do not open a public issue for credentials, private-vault exposure, unsafe path handling, or other security-sensitive findings.

Include:

- the affected SkillSync version;
- the operating system and installation method;
- a minimal reproduction;
- the expected and observed behavior;
- whether user files, Git credentials, or private skill content may be exposed.

## Trust model

SkillSync uses a user-owned private GitHub repository as its control plane. Every authenticated device with write access to that vault can change skill content and device assignments. SkillSync does not provide per-device access control for a shared multi-user vault.

Skill folders can contain executable instructions or supporting scripts. Users should review third-party skills before adding them to a vault.
