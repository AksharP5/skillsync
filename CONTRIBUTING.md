# Contributing

Thanks for helping improve SkillSync.

## Development setup

Requirements:

- Node.js 20 or newer
- Git

Run:

```bash
git clone https://github.com/AksharP5/skillsync.git
cd skillsync
npm install
npm test
npm pack --dry-run
```

## Pull requests

1. Open an issue first for behavior or data-model changes that affect existing vaults.
2. Create a focused branch from `main`.
3. Add or update tests for every behavior change.
4. Preserve backward compatibility for existing `registry.json`, `vault.json`, and `devices/*.json` files.
5. Run `npm test`, `npm pack --dry-run`, and `git diff --check`.
6. Explain user-visible behavior, migration impact, and safety boundaries in the pull request.

Use conventional commits because releases are automated:

- `fix:` for a patch
- `feat:` for a minor release
- `feat!:` or `BREAKING CHANGE:` for a major release

## Safety expectations

SkillSync manages user-authored directories and private Git repositories. Changes must:

- never overwrite an unmanaged local path silently;
- avoid uploading newly detected local skills unless the target explicitly enables automatic import;
- preserve a recoverable copy before replacing user-owned content;
- avoid periodic repository writes when no meaningful state changed;
- keep destructive vault deletion explicit or policy-controlled and covered by tests.
