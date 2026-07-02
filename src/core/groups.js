import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, exists, readJson, writeJson } from './fs.js';
import { loadRegistry } from './registry.js';

const GROUPS_CONFIG_FILE = 'groups.json';

const DEFAULT_PACKS = {
  hyperframes: {
    title: 'HyperFrames video + motion',
    description: 'HyperFrames generation, animation, keyframes, media, registry, and product-video workflows.',
    skills: [
      'hyperframes',
      'hyperframes-core',
      'hyperframes-cli',
      'hyperframes-animation',
      'hyperframes-keyframes',
      'hyperframes-media',
      'hyperframes-creative',
      'hyperframes-registry',
      'hyperframes-keyframe-promo-motion',
      'motion-graphics',
      'media-use',
      'product-launch-video',
      'website-to-video',
      'video-use-hyperframes',
      'bog-hyperframes',
      'launch-product-video-hyperframes',
    ],
  },
  engineering: {
    title: 'Engineering + code quality',
    description: 'Language guardrails, debugging, code review, repo operations, and software delivery.',
    skills: [
      'typescript',
      'python',
      'rust',
      'golang',
      'debugging-workflows',
      'github-operations',
      'codebase-inspection',
      'test-driven-development',
      'requesting-code-review',
      'github-code-review',
      'github-issues',
      'github-pr-workflow',
      'github-repo-management',
      'npm-release-publishing',
    ],
  },
  hermes: {
    title: 'Hermes + agent operations',
    description: 'Hermes configuration, skill management, agent orchestration, kanban, and gateway workflows.',
    skills: [
      'hermes-agent',
      'hermes-agent-development',
      'hermes-agent-skill-authoring',
      'ai-agent-skill-management',
      'agent-skill-vault-sync',
      'kanban-workflows',
      'kanban-codex-lane',
      'kanban-orchestrator',
      'kanban-worker',
      'subagent-driven-development',
      'claude-code',
      'codex',
      'opencode',
    ],
  },
  apple: {
    title: 'Apple platforms',
    description: 'Apple automation, Swift, SwiftUI, and macOS/iMessage workflows.',
    skills: [
      'apple-platform-automation',
      'apple-notes',
      'apple-reminders',
      'swift-concurrency-expert',
      'swiftui-performance-audit',
      'swiftui-view-refactor',
      'macos-computer-use',
      'imessage',
    ],
  },
  content: {
    title: 'Content + creator workflows',
    description: 'Short-form, YouTube, social, media, music, writing, and product/content production workflows.',
    skills: [
      'youtube-content',
      'youtube-growth-bogxd',
      'media-and-platform-operations',
      'product-video-production',
      'social-reel-motion-adaptation',
      'creative-content-production',
      'motion-reference-analysis',
      'faceless-explainer',
      'embedded-captions',
      'talking-head-recut',
      'music-to-video',
      'pr-to-video',
      'songwriting-and-ai-music',
      'gif-search',
      'audiocraft',
    ],
  },
  design: {
    title: 'Design + visual artifacts',
    description: 'Frontend taste, diagrams, sketches, illustrations, presentations, and visual design systems.',
    skills: [
      'frontend-design',
      'design-taste-frontend',
      'browser-visual-artifacts',
      'architecture-diagram',
      'excalidraw',
      'excalidraw-diagrams',
      'ascii-art',
      'ascii-video',
      'pixel-art',
      'paper-deck-style',
      'powerpoint',
      'design-md',
      'popular-web-designs',
    ],
  },
};

const DEFAULT_SOURCE_LABELS = {
  curated: 'Mine / curated',
  generated: 'Generated / experimental',
  bundled: 'Bundled / default',
  third_party: 'Third-party / imported',
  unknown: 'Unclassified',
};

export async function generateGroups({ vaultPath, write = true } = {}) {
  const registry = await loadRegistry(vaultPath);
  const skillNames = Object.keys(registry.skills).sort();
  const config = await loadGroupsConfig(vaultPath);
  const packs = normalizePacks(config.packs || DEFAULT_PACKS, skillNames);
  const sourceMap = buildSourceMap(config.sources || {}, packs, skillNames);
  const categories = buildCategories({ configuredCategories: config.categories || {}, packs, skillNames });
  const docs = buildDocs({ skillNames, packs, sourceMap, categories });

  if (write) {
    await writeGroupFiles(vaultPath, docs, packs);
  }

  return {
    skillCount: skillNames.length,
    packCount: Object.keys(packs).length,
    sourceCounts: countBySource(sourceMap),
    files: docs.files,
  };
}

async function loadGroupsConfig(vaultPath) {
  const configPath = path.join(vaultPath, GROUPS_CONFIG_FILE);
  if (!await exists(configPath)) return {};
  const value = await readJson(configPath, {});
  return value && typeof value === 'object' ? value : {};
}

function normalizePacks(packConfig, skillNames) {
  const available = new Set(skillNames);
  const packs = {};
  for (const [packName, raw] of Object.entries(packConfig)) {
    const pack = Array.isArray(raw) ? { title: titleCase(packName), skills: raw } : raw;
    const skills = [...new Set((pack.skills || []).filter((name) => available.has(name)))].sort();
    if (!skills.length) continue;
    packs[packName] = {
      name: packName,
      title: pack.title || titleCase(packName),
      description: pack.description || '',
      skills,
    };
  }
  return packs;
}

function buildSourceMap(sourceConfig, packs, skillNames) {
  const sources = new Map(skillNames.map((name) => [name, 'unknown']));
  for (const [source, names] of Object.entries(sourceConfig)) {
    if (!Array.isArray(names)) continue;
    for (const name of names) {
      if (sources.has(name)) sources.set(name, normalizeSource(source));
    }
  }

  // Safe, non-destructive defaults: skills explicitly created/managed as personal packs
  // are curated unless the user overrides them in groups.json.
  for (const name of packs.hyperframes?.skills || []) {
    if (name.includes('hyperframes') || name === 'motion-graphics' || name === 'product-launch-video' || name === 'website-to-video') {
      if (sources.get(name) === 'unknown') sources.set(name, 'curated');
    }
  }

  return sources;
}

function normalizeSource(source) {
  if (source === 'user' || source === 'mine' || source === 'personal') return 'curated';
  if (source === 'third-party') return 'third_party';
  return ['curated', 'generated', 'bundled', 'third_party', 'unknown'].includes(source) ? source : 'unknown';
}

function buildCategories({ configuredCategories, packs, skillNames }) {
  const categories = {};
  for (const [category, names] of Object.entries(configuredCategories)) {
    if (!Array.isArray(names)) continue;
    categories[category] = names.filter((name) => skillNames.includes(name)).sort();
  }
  for (const [packName, pack] of Object.entries(packs)) {
    if (!categories[packName]) categories[packName] = pack.skills;
  }
  const assigned = new Set(Object.values(categories).flat());
  const ungrouped = skillNames.filter((name) => !assigned.has(name));
  if (ungrouped.length) categories.ungrouped = ungrouped;
  return categories;
}

function buildDocs({ skillNames, packs, sourceMap, categories }) {
  const now = new Date().toISOString();
  const files = ['README.md', 'GROUPS.md'];
  const readme = [
    '# skills',
    '',
    'Private AI agent skills vault managed by SkillSync.',
    '',
    `- Skills in vault: **${skillNames.length}**`,
    `- Packs: **${Object.keys(packs).length}**`,
    '- `skills/` contains skill folders.',
    '- `packs/` contains generated installable pack manifests.',
    '- `groups/` contains generated visual group pages.',
    '- `registry.json` is generated by SkillSync.',
    '- `devices/` contains generated per-device install state.',
    '',
    'Start here: **[GROUPS.md](GROUPS.md)**',
    '',
    'Do not store secrets in skills.',
    '',
  ].join('\n');

  const groups = [];
  groups.push('# Skill groups');
  groups.push('');
  groups.push('Generated by `skillsync groups`. Edit `groups.json` to override sources, packs, or categories; do not hand-edit generated `packs/*.json` / `groups/*.md`.');
  groups.push('');
  groups.push(`Last generated: ${now}`);
  groups.push('');

  groups.push('## Sources');
  groups.push('');
  const sourceBuckets = bucketBySource(skillNames, sourceMap);
  for (const source of ['curated', 'generated', 'third_party', 'bundled', 'unknown']) {
    const names = sourceBuckets[source] || [];
    if (!names.length) continue;
    groups.push(`### ${DEFAULT_SOURCE_LABELS[source]} (${names.length})`);
    groups.push('');
    groups.push(skillList(names));
    groups.push('');
  }

  groups.push('## Packs');
  groups.push('');
  for (const pack of Object.values(packs).sort((a, b) => a.title.localeCompare(b.title))) {
    files.push(`packs/${pack.name}.json`, `groups/${pack.name}.md`);
    groups.push(`### [${pack.title}](groups/${pack.name}.md) (${pack.skills.length})`);
    groups.push('');
    if (pack.description) groups.push(`${pack.description}\n`);
    groups.push(skillList(pack.skills));
    groups.push('');
  }

  groups.push('## All groups / categories');
  groups.push('');
  for (const [category, names] of Object.entries(categories).sort(([a], [b]) => a.localeCompare(b))) {
    groups.push(`<details><summary>${titleCase(category)} (${names.length})</summary>`);
    groups.push('');
    groups.push(skillList(names));
    groups.push('');
    groups.push('</details>');
    groups.push('');
  }

  return {
    readme,
    groups: `${groups.join('\n')}\n`,
    packPages: Object.fromEntries(Object.values(packs).map((pack) => [pack.name, packPage(pack)])),
    packJson: Object.fromEntries(Object.values(packs).map((pack) => [pack.name, {
      name: pack.name,
      title: pack.title,
      description: pack.description,
      skills: pack.skills,
      generated_by: 'skillsync groups',
      generated_at: now,
    }])),
    files,
  };
}

async function writeGroupFiles(vaultPath, docs, packs) {
  await writeFile(path.join(vaultPath, 'README.md'), docs.readme);
  await writeFile(path.join(vaultPath, 'GROUPS.md'), docs.groups);
  await ensureDir(path.join(vaultPath, 'packs'));
  await ensureDir(path.join(vaultPath, 'groups'));
  for (const packName of Object.keys(packs)) {
    await writeJson(path.join(vaultPath, 'packs', `${packName}.json`), docs.packJson[packName]);
    await writeFile(path.join(vaultPath, 'groups', `${packName}.md`), docs.packPages[packName]);
  }
}

function packPage(pack) {
  return [
    `# ${pack.title}`,
    '',
    pack.description || '',
    '',
    `Skills: **${pack.skills.length}**`,
    '',
    '```bash',
    `skillsync pack install ${pack.name} --target codex`,
    '```',
    '',
    skillList(pack.skills),
    '',
  ].join('\n');
}

function bucketBySource(skillNames, sourceMap) {
  const buckets = {};
  for (const name of skillNames) {
    const source = sourceMap.get(name) || 'unknown';
    if (!buckets[source]) buckets[source] = [];
    buckets[source].push(name);
  }
  return buckets;
}

function countBySource(sourceMap) {
  const counts = {};
  for (const source of sourceMap.values()) counts[source] = (counts[source] || 0) + 1;
  return counts;
}

function skillList(names) {
  if (!names.length) return '_None._';
  return names.map((name) => `- [${name}](skills/${name}/SKILL.md)`).join('\n');
}

function titleCase(value) {
  return String(value)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
