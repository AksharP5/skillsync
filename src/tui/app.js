import {
  BoxRenderable,
  CliRenderEvents,
  CodeRenderable,
  InputRenderable,
  InputRenderableEvents,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  SyntaxStyle,
  TextareaRenderable,
  TextRenderable,
  createCliRenderer,
} from '@opentui/core';

import {
  applyLinks,
  listDevices,
  loadLocalDevice,
  setDeviceAutoImport,
  setSkillTargets,
  setTargetAutoImport,
  uninstallSkillAndPrune,
} from '../core/device.js';
import { loadRegistry, loadVaultConfig, refreshChangedRegistryEntries, setVaultPolicy } from '../core/registry.js';
import { cancelRunningCommands } from '../core/git.js';
import { syncVault } from '../core/sync.js';
import { loadSkillDocument, saveSkillDocument } from '../core/skills.js';
import {
  TUI_PAGES,
  countAssignedDeviceSkills,
  countDeviceSkills,
  deviceSkillInventory,
  filterSkillNames,
  pendingDeviceCount,
  skillAssignmentTargets,
  skillDevicePlacements,
  splitSkillDocument,
  targetDetectedCount,
  truncateLine,
} from './model.js';
import {
  DEFAULT_KEYBINDINGS,
  bindingLabel,
  defaultTuiPreferencesPath,
  keyMatches,
  loadTuiPreferences,
} from './preferences.js';

const COLORS = {
  bg: '#030403',
  surface: '#080A08',
  surfaceRaised: '#10130D',
  border: '#3D4435',
  borderActive: '#D9FF43',
  text: '#E2E5DC',
  muted: '#7E8479',
  faint: '#42473F',
  accent: '#D9FF43',
  accentSoft: '#11150D',
  selectedText: '#D9FF43',
  selectedMuted: '#A7AF9D',
  success: '#A5E66F',
  warning: '#FFB547',
  danger: '#F07178',
};

function syntaxStyle() {
  return SyntaxStyle.fromStyles({
    default: { fg: COLORS.text },
    'markup.heading': { fg: COLORS.accent, bold: true },
    'markup.heading.1': { fg: '#E8FF8F', bold: true },
    'markup.heading.2': { fg: '#D9FF43', bold: true },
    'markup.bold': { fg: COLORS.text, bold: true },
    'markup.italic': { fg: '#B8BDAF', italic: true },
    'markup.raw': { fg: '#DDE6C5', bg: COLORS.surfaceRaised },
    'markup.link': { fg: COLORS.accent, underline: true },
    'markup.list': { fg: COLORS.muted },
    comment: { fg: COLORS.muted, italic: true },
    string: { fg: '#A5E66F' },
    keyword: { fg: '#D9FF43' },
    function: { fg: '#E8FF8F' },
    number: { fg: '#FFB547' },
    punctuation: { fg: '#9BA291' },
  });
}

function text(ctx, options) {
  return new TextRenderable(ctx, {
    fg: COLORS.text,
    wrapMode: 'word',
    ...options,
  });
}

function box(ctx, options) {
  return new BoxRenderable(ctx, {
    backgroundColor: COLORS.bg,
    ...options,
  });
}

function tableCell(value, width) {
  const textValue = String(value || '');
  if (textValue.length <= width) return textValue.padEnd(width);
  if (width <= 1) return '…';
  return `${textValue.slice(0, width - 1)}…`;
}

function placementMarker(status) {
  if (status === 'managed') return '●';
  if (status === 'pending') return '!';
  if (status === 'detected') return '○';
  return '·';
}

function placementTargets(placement) {
  if (placement.assignedTargets.length) return placement.assignedTargets.join('+');
  if (placement.detectedTargets.length) return `${placement.detectedTargets.join('+')}*`;
  return 'none';
}

function placementCell(placement) {
  return `${placementMarker(placement.status)} ${placementTargets(placement)}`;
}

function pendingHighlights(renderable) {
  const own = renderable instanceof CodeRenderable ? [renderable.highlightingDone] : [];
  return [
    ...own,
    ...renderable.getChildren().flatMap((child) => pendingHighlights(child)),
  ];
}

export class SkillSyncTui {
  constructor({ config, renderer, onExit, preferences = null }) {
    this.config = config;
    this.renderer = renderer;
    this.onExit = onExit;
    this.page = 'skills';
    this.mode = 'browse';
    this.query = '';
    this.documents = new Map();
    this.selectedByPage = new Map();
    this.status = { tone: 'muted', message: 'Loading vault…' };
    this.busy = false;
    this.snapshot = null;
    this.activeDocument = null;
    this.documentRequest = 0;
    this.paletteCommands = [];
    this.targetSelection = new Set();
    this.updatingList = false;
    this.cancelRequested = false;
    this.exitWhenIdle = false;
    this.focusArea = 'list';
    this.editorMode = null;
    this.bindings = preferences?.keybindings || DEFAULT_KEYBINDINGS;
    this.preferencesPath = preferences?.path || defaultTuiPreferencesPath();
    this.theme = syntaxStyle();
    this.handleKey = this.handleKey.bind(this);
  }

  async start() {
    this.buildLayout();
    this.updateResponsiveLayout();
    this.renderer.keyInput.on('keypress', this.handleKey);
    this.renderer.on(CliRenderEvents.RESIZE, () => this.updateResponsiveLayout());
    await this.reload({ refreshRegistry: true });
    this.setBrowseFocus('list');
  }

  buildLayout() {
    this.root = box(this.renderer, {
      id: 'skillsync-root',
      width: '100%',
      height: '100%',
      flexDirection: 'column',
    });
    this.renderer.root.add(this.root);

    const header = box(this.renderer, {
      height: 2,
      flexShrink: 0,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      border: ['bottom'],
      borderColor: COLORS.border,
      backgroundColor: COLORS.surface,
      paddingX: 1,
    });
    this.brand = text(this.renderer, {
      content: 'skillsync',
      fg: COLORS.accent,
      attributes: 1,
      width: 16,
      height: 1,
    });
    this.navText = text(this.renderer, { content: '', height: 1, flexGrow: 1 });
    this.headerMeta = text(this.renderer, {
      content: '',
      fg: COLORS.muted,
      height: 1,
      width: 'auto',
      marginLeft: 2,
    });
    header.add(this.brand);
    header.add(this.navText);
    header.add(this.headerMeta);
    this.root.add(header);

    this.searchBar = box(this.renderer, {
      height: 2,
      flexShrink: 0,
      flexDirection: 'row',
      alignItems: 'center',
      visible: false,
      border: ['bottom'],
      borderColor: COLORS.borderActive,
      paddingX: 1,
    });
    this.searchBar.add(text(this.renderer, {
      content: '/ ',
      fg: COLORS.accent,
      attributes: 1,
      width: 2,
      height: 1,
    }));
    this.searchInput = new InputRenderable(this.renderer, {
      id: 'skill-search',
      value: '',
      placeholder: 'Filter skills by name or loaded content',
      height: 1,
      flexGrow: 1,
      backgroundColor: COLORS.bg,
      focusedBackgroundColor: COLORS.bg,
      textColor: COLORS.text,
      focusedTextColor: COLORS.text,
      placeholderColor: COLORS.faint,
      onContentChange: () => {
        this.query = this.searchInput.value;
        this.updateList({ preserveSelection: true });
      },
    });
    this.searchInput.on(InputRenderableEvents.ENTER, () => this.closeSearch());
    this.searchBar.add(this.searchInput);
    this.root.add(this.searchBar);

    this.workspace = box(this.renderer, {
      flexGrow: 1,
      minHeight: 6,
      flexDirection: 'row',
    });
    this.root.add(this.workspace);

    this.listPane = box(this.renderer, {
      id: 'list-pane',
      width: '34%',
      minWidth: 28,
      maxWidth: 46,
      height: '100%',
      flexShrink: 0,
      flexDirection: 'column',
      border: ['right'],
      borderColor: COLORS.border,
      focusedBorderColor: COLORS.borderActive,
    });
    this.listHeader = box(this.renderer, {
      height: 2,
      flexShrink: 0,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      border: ['bottom'],
      borderColor: COLORS.border,
      paddingX: 1,
    });
    this.listTitle = text(this.renderer, {
      content: 'Skills',
      attributes: 1,
      height: 1,
      width: 'auto',
    });
    this.listCount = text(this.renderer, {
      content: '',
      fg: COLORS.muted,
      height: 1,
      width: 'auto',
    });
    this.listHeader.add(this.listTitle);
    this.listHeader.add(this.listCount);
    this.listPane.add(this.listHeader);
    this.list = new SelectRenderable(this.renderer, {
      id: 'primary-list',
      width: '100%',
      height: '100%',
      options: [],
      backgroundColor: COLORS.bg,
      textColor: COLORS.text,
      focusedBackgroundColor: COLORS.bg,
      focusedTextColor: COLORS.text,
      selectedBackgroundColor: COLORS.accentSoft,
      selectedTextColor: COLORS.selectedText,
      descriptionColor: COLORS.muted,
      selectedDescriptionColor: COLORS.selectedMuted,
      showDescription: true,
      showSelectionIndicator: true,
      showScrollIndicator: true,
      wrapSelection: false,
      itemSpacing: 0,
    });
    this.list.on(SelectRenderableEvents.SELECTION_CHANGED, (index, option) => {
      if (!option || this.updatingList) return;
      this.selectedByPage.set(this.page, option.value);
      void this.updateDetail(option.value);
    });
    this.list.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
      if (this.page === 'skills' && option) void this.openTargetPicker(option.value);
    });
    this.listPane.add(this.list);
    this.workspace.add(this.listPane);

    this.detailPane = box(this.renderer, {
      id: 'detail-pane',
      height: '100%',
      flexGrow: 1,
      minWidth: 32,
      flexDirection: 'column',
    });
    this.detailHeader = box(this.renderer, {
      height: 3,
      flexShrink: 0,
      border: ['bottom'],
      borderColor: COLORS.border,
      paddingX: 2,
      justifyContent: 'center',
    });
    this.detailMeta = text(this.renderer, {
      content: '',
      height: 2,
      fg: COLORS.muted,
      wrapMode: 'word',
    });
    this.detailHeader.add(this.detailMeta);
    this.detailPane.add(this.detailHeader);
    this.previewScroll = new ScrollBoxRenderable(this.renderer, {
      id: 'skill-preview-scroll',
      flexGrow: 1,
      width: '100%',
      minHeight: 3,
      scrollY: true,
      scrollX: false,
      stickyScroll: false,
      viewportCulling: true,
      backgroundColor: COLORS.bg,
      verticalScrollbarOptions: {
        trackOptions: { backgroundColor: COLORS.bg },
      },
      paddingX: 2,
      paddingY: 1,
    });
    this.markdown = new MarkdownRenderable(this.renderer, {
      id: 'skill-preview',
      content: 'Loading…',
      syntaxStyle: this.theme,
      streaming: true,
      width: '100%',
      height: 'auto',
      flexShrink: 0,
      fg: COLORS.text,
      bg: COLORS.bg,
      conceal: true,
      concealCode: false,
      internalBlockMode: 'top-level',
      tableOptions: {
        style: 'columns',
        borders: false,
        wrapMode: 'word',
      },
      renderNode: (token) => {
        if (token.type !== 'code') return undefined;
        return text(this.renderer, {
          content: token.text,
          width: '100%',
          height: 'auto',
          flexShrink: 0,
          fg: '#DDE6C5',
          bg: COLORS.surfaceRaised,
          selectable: true,
          wrapMode: 'char',
        });
      },
    });
    this.previewScroll.add(this.markdown);
    this.detailPane.add(this.previewScroll);
    this.workspace.add(this.detailPane);

    this.footer = box(this.renderer, {
      height: 2,
      flexShrink: 0,
      flexDirection: 'row',
      alignItems: 'center',
      border: ['top'],
      borderColor: COLORS.border,
      backgroundColor: COLORS.surface,
      paddingX: 1,
    });
    this.footerHints = text(this.renderer, {
      content: '',
      fg: COLORS.muted,
      height: 1,
      flexGrow: 1,
      truncate: true,
    });
    this.footerStatus = text(this.renderer, {
      content: '',
      fg: COLORS.muted,
      height: 1,
      width: 'auto',
      marginLeft: 2,
      truncate: true,
    });
    this.footer.add(this.footerHints);
    this.footer.add(this.footerStatus);
    this.root.add(this.footer);
    this.renderChrome();
  }

  async reload({ refreshRegistry = false, message = null } = {}) {
    const selected = this.selectedByPage.get(this.page);
    if (refreshRegistry) await refreshChangedRegistryEntries(this.config.repoPath);
    const [registry, localDevice, devices, vaultConfig] = await Promise.all([
      loadRegistry(this.config.repoPath),
      loadLocalDevice(this.config.repoPath, this.config.deviceId),
      listDevices(this.config.repoPath),
      loadVaultConfig(this.config.repoPath),
    ]);
    const visibleDevices = devices.map((device) => (
      device.device_id === this.config.deviceId ? localDevice : device
    ));
    if (!visibleDevices.some((device) => device.device_id === this.config.deviceId)) {
      visibleDevices.push(localDevice);
    }
    this.snapshot = {
      registry,
      localDevice,
      devices: visibleDevices,
      vaultConfig,
      skills: Object.keys(registry.skills).sort(),
    };
    if (selected) this.selectedByPage.set(this.page, selected);
    if (message) this.setStatus(message, 'success');
    else if (this.status.message === 'Loading vault…') this.setStatus('Ready', 'muted');
    this.updateList({ preserveSelection: true });
    this.renderChrome();
  }

  skillTableLayout() {
    const devices = this.snapshot?.devices || [];
    const contentWidth = Math.max(32, this.renderer.width - 5);
    const skillWidth = Math.max(14, Math.min(30, Math.floor(contentWidth * 0.25)));
    const updatedWidth = contentWidth - skillWidth - devices.length > devices.length * 10 + 9 ? 9 : 0;
    const separators = devices.length + (updatedWidth ? 1 : 0);
    const deviceWidth = devices.length
      ? Math.max(1, Math.floor((contentWidth - skillWidth - updatedWidth - separators) / devices.length))
      : 0;
    return { devices, skillWidth, updatedWidth, deviceWidth };
  }

  skillTableHeader() {
    const { devices, skillWidth, updatedWidth, deviceWidth } = this.skillTableLayout();
    return [
      tableCell(`SKILL / ${this.snapshot?.skills.length || 0}`, skillWidth),
      ...(updatedWidth ? [tableCell('UPDATED', updatedWidth)] : []),
      ...devices.map((device) => tableCell(device.display_name || device.device_id, deviceWidth)),
    ].join(' ');
  }

  skillTableRow(skillName) {
    const { devices, skillWidth, updatedWidth, deviceWidth } = this.skillTableLayout();
    const entry = this.snapshot.registry.skills[skillName];
    const placements = skillDevicePlacements(devices, skillName);
    const updatedAt = entry?.updated_at ? new Date(entry.updated_at) : null;
    const age = updatedAt && Number.isFinite(updatedAt.getTime())
      ? this.compactAge(Date.now() - updatedAt.getTime())
      : 'unknown';
    return [
      tableCell(skillName, skillWidth),
      ...(updatedWidth ? [tableCell(age, updatedWidth)] : []),
      ...placements.map((placement) => tableCell(placementCell(placement), deviceWidth)),
    ].join(' ');
  }

  compactAge(milliseconds) {
    const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }

  skillDestinationMarkdown(skillName) {
    const placements = skillDevicePlacements(this.snapshot.devices, skillName);
    return placements.flatMap((placement) => {
      if (placement.status === 'absent') {
        return [`### ${placement.displayName}`, '', '- · Not installed', ''];
      }
      const currentDevice = placement.deviceId === this.config.deviceId;
      const locations = placement.locations.map((location) => {
        const state = location.target === 'global'
          ? 'device-level assignment'
          : location.assigned && location.detected
            ? `managed${location.mode ? ` ${location.mode}` : ''}`
            : location.assigned
              ? 'assigned · not detected'
              : `detected · unmanaged${location.inVault ? ' · in vault' : ' · local only'}`;
        const path = currentDevice && location.path
          ? ` · \`${location.path}\``
          : location.target === 'global'
            ? ''
            : ' · path private to device';
        const marker = location.assigned && (location.detected || location.target === 'global')
          ? '●'
          : location.assigned ? '!' : '○';
        return `- ${marker} **${location.target}** · ${state}${path}`;
      });
      return [`### ${placement.displayName}`, '', ...locations, ''];
    });
  }

  pageItems() {
    if (!this.snapshot) return [];
    if (this.page === 'skills') {
      return filterSkillNames(this.snapshot.skills, this.query, this.documents).map((name) => ({
        value: name,
        name: this.skillTableRow(name),
        description: '',
      }));
    }
    if (this.page === 'devices') {
      return this.snapshot.devices.map((device) => {
        const visible = countDeviceSkills(device);
        const assigned = countAssignedDeviceSkills(device);
        return {
          value: device.device_id,
          name: `${device.device_id === this.config.deviceId ? '+' : ' '} ${device.display_name}`,
          description: `${visible} visible · ${assigned} assigned · ${device.desired_generation === device.applied_generation ? 'synced' : 'pending'}`,
        };
      });
    }
    if (this.page === 'targets') {
      return Object.entries(this.snapshot.localDevice.targets || {}).sort(([left], [right]) => left.localeCompare(right)).map(([name, target]) => ({
        value: name,
        name: `${target.auto_import ? '+' : ' '} ${name}`,
        description: `${target.mode} · ${targetDetectedCount(this.snapshot.localDevice, name)} detected`,
      }));
    }
    return [
      {
        value: 'sync',
        name: 'Sync now',
        description: 'Pull, apply, scan, commit, and push',
      },
      {
        value: 'scan',
        name: 'Scan local targets',
        description: 'Refresh local inventory without pulling first',
      },
      {
        value: 'auto-adopt',
        name: `Auto-adopt new skills: ${this.deviceAutoAdoptState()}`,
        description: 'Set this across all local targets',
      },
      {
        value: 'delete-unassigned',
        name: `Delete fully unassigned skills: ${this.snapshot.vaultConfig.policies.delete_unassigned_skills ? 'on' : 'off'}`,
        description: 'Vault-wide cleanup policy',
      },
      {
        value: 'keybindings',
        name: 'Keybindings',
        description: 'Vim defaults · user-local overrides',
      },
      {
        value: 'advanced',
        name: 'Advanced management',
        description: 'Open matrix, imports, packs, maintenance, and connection tools',
      },
    ];
  }

  updateList({ preserveSelection = false } = {}) {
    const items = this.pageItems();
    const previous = preserveSelection ? this.selectedByPage.get(this.page) : null;
    this.updatingList = true;
    try {
      this.list.options = items;
      let index = items.findIndex((item) => item.value === previous);
      if (index === -1) index = Math.min(this.list.getSelectedIndex(), Math.max(0, items.length - 1));
      this.list.setSelectedIndex(index);
    } finally {
      this.updatingList = false;
    }
    if (this.page === 'skills') {
      this.listTitle.content = this.skillTableHeader();
      this.listCount.content = '';
    } else {
      this.listTitle.content = TUI_PAGES.find((page) => page.id === this.page)?.label || 'Skills';
      this.listCount.content = String(items.length);
    }
    if (!items.length) {
      this.detailMeta.content = '';
      this.markdown.content = this.page === 'skills'
        ? '# No matching skills\n\nPress `/` to change the filter or `ctrl+p` for commands.'
        : '# Nothing here yet';
    } else {
      const option = this.list.getSelectedOption();
      if (option) void this.updateDetail(option.value);
    }
    this.renderChrome();
  }

  async updateDetail(value) {
    if (!this.snapshot || !value) return;
    this.previewScroll.scrollTo({ x: 0, y: 0 });
    if (this.page === 'skills') {
      const request = ++this.documentRequest;
      const entry = this.snapshot.registry.skills[value];
      this.detailPane.title = ' Preview ';
      this.detailMeta.content = `${value}\n${entry?.path || `skills/${value}`}`;
      const cached = this.documents.get(value);
      if (cached?.hash === entry?.hash) {
        this.renderSkillDocument(value, cached);
        return;
      }
      this.markdown.content = 'Loading skill…';
      try {
        const document = await loadSkillDocument({ vaultPath: this.config.repoPath, skillName: value });
        if (this.exiting || request !== this.documentRequest || this.page !== 'skills') return;
        this.documents.set(value, document);
        this.renderSkillDocument(value, document);
      } catch (error) {
        if (this.exiting || request !== this.documentRequest) return;
        this.markdown.content = `# Could not load ${value}\n\n${error.message}`;
      }
      return;
    }

    if (this.page === 'devices') {
      const device = this.snapshot.devices.find((candidate) => candidate.device_id === value);
      if (!device) return;
      const inventory = deviceSkillInventory(device);
      const assigned = inventory.filter((skill) => skill.assigned).length;
      const detected = inventory.filter((skill) => skill.detected).length;
      const targets = Object.entries(device.targets || {}).map(([name, target]) => (
        `- **${name}**${target.path ? ` · ${target.mode} · \`${target.path}\`` : ' · path private to device'} · ${target.auto_import ? 'auto-adopt on' : 'auto-adopt off'}`
      ));
      const skills = inventory.flatMap((skill) => [
        `### ${skill.name}`,
        '',
        ...skill.locations.map((location) => {
          if (location.target === 'global') return '- **global** · device-level assignment';
          const state = location.assigned && location.detected
            ? location.mode ? `managed ${location.mode}` : 'assigned and detected'
            : location.assigned
              ? 'assigned · not detected'
              : `unmanaged · detected${location.inVault ? ' · in vault' : ' · local only'}`;
          return `- **${location.target}** · ${state}${location.path ? ` · \`${location.path}\`` : ' · path private to device'}`;
        }),
        '',
      ]);
      this.detailPane.title = ' Device ';
      this.detailMeta.content = `${device.display_name}\n${device.device_id === this.config.deviceId ? 'This device · exact local paths' : 'Remote device · paths remain private'}`;
      this.markdown.content = [
        `# ${device.display_name}`,
        '',
        device.desired_generation === device.applied_generation
          ? `Synced at generation **${device.applied_generation}**.`
          : `Pending generation **${device.desired_generation}**. Last applied: ${device.applied_generation}.`,
        '',
        '## Targets',
        '',
        ...(targets.length ? targets : ['_No reported targets._']),
        '',
        `## Skills (${inventory.length})`,
        '',
        `**${assigned} assigned · ${detected} detected**`,
        '',
        ...(skills.length ? skills : ['_No assigned or detected skills._']),
      ].join('\n');
      return;
    }

    if (this.page === 'targets') {
      const target = this.snapshot.localDevice.targets[value];
      if (!target) return;
      const detected = this.snapshot.localDevice.detected?.[value] || [];
      this.detailPane.title = ' Target ';
      this.detailMeta.content = `${value}\n${target.path}`;
      this.markdown.content = [
        `# ${value}`,
        '',
        `- Mode: **${target.mode}**`,
        `- Auto-adopt: **${target.auto_import ? 'on' : 'off'}**`,
        `- Install path: \`${target.path}\``,
        ...(target.scan_path ? [`- Scan path: \`${target.scan_path}\``] : []),
        '',
        `## Detected skills (${detected.length})`,
        '',
        ...(detected.length ? detected.map((skill) => `- ${skill.name}${skill.in_vault ? ' · in vault' : ' · local only'}${skill.path ? ` · \`${skill.path}\`` : ''}`) : ['_Nothing detected._']),
        '',
        'Press `space` to toggle auto-adopt for this target.',
      ].join('\n');
      return;
    }

    const keybindingRows = Object.entries(this.bindings).map(([action, bindings]) => (
      `- \`${action}\`: ${bindings.length ? bindings.map((binding) => `\`${binding}\``).join(', ') : '_disabled_'}`
    ));
    const descriptions = {
      sync: '# Sync now\n\nPull the latest vault, apply desired assignments, auto-adopt new local skills, refresh projections, commit real changes, and push.',
      scan: '# Scan local targets\n\nRun the local reconciliation pass without pulling first.',
      'auto-adopt': '# Auto-adopt\n\nWhen enabled, genuinely new skill folders created inside managed agent targets are adopted into the private vault on the next sync.',
      'delete-unassigned': '# Delete fully unassigned skills\n\nWhen enabled, SkillSync only removes a skill after every device has removed its assignment and reported the local copy gone.',
      keybindings: [
        '# Keybindings',
        '',
        `User-local config: \`${this.preferencesPath}\``,
        '',
        'Every SkillSync action can be rebound or disabled. Edit the file, then press `enter` here to reload it.',
        '',
        '```json',
        '{',
        '  "keybindings": {',
        '    "move.down": ["j", "down"],',
        '    "move.up": ["k", "up"],',
        '    "focus.detail": ["l", "right"],',
        '    "focus.list": ["h", "left"],',
        '    "editor.insert.before": ["i"],',
        '    "editor.insert.after": ["a"],',
        '    "sync": ["ctrl+y"],',
        '    "quit": []',
        '  }',
        '}',
        '```',
        '',
        'An empty array disables an action. Unspecified actions keep their defaults.',
        '',
        '## Current bindings',
        '',
        ...keybindingRows,
      ].join('\n'),
      advanced: '# Advanced management\n\nOpen the complete interactive menu for the skill matrix, remote assignments, add/import flows, packs, groups, deletion, diagnostics, background service, vault connections, global instructions, and targets.',
    };
    this.detailPane.title = ' Action ';
    this.detailMeta.content = '';
    this.markdown.content = descriptions[value] || '';
  }

  renderSkillDocument(skillName, document) {
    this.activeDocument = document;
    const { body, description } = splitSkillDocument(document.content);
    const placements = skillDevicePlacements(this.snapshot.devices, skillName);
    const managed = placements.filter((placement) => placement.status === 'managed').length;
    const pending = placements.filter((placement) => placement.status === 'pending').length;
    const unmanaged = placements.filter((placement) => placement.status === 'detected').length;
    const updated = document.updatedAt ? new Date(document.updatedAt).toLocaleString() : 'unknown';
    this.detailMeta.content = [
      skillName,
      '',
      document.relativePath,
      `updated ${updated}`,
      '',
      `${managed} managed`,
      `${pending} assigned · missing`,
      `${unmanaged} unmanaged`,
      '',
      '● managed',
      '! assigned · missing',
      '○ detected · unmanaged',
      '· not installed',
    ].join('\n');
    this.markdown.content = [
      ...(description ? [`# ${description}`, ''] : []),
      '## Destinations',
      '',
      ...this.skillDestinationMarkdown(skillName),
      '---',
      '',
      body.trim() || '_This skill has no Markdown body._',
    ].join('\n');
    this.updateListDescriptions(skillName);
  }

  updateListDescriptions(skillName) {
    if (this.page !== 'skills') return;
    const current = this.list.options.find((option) => option.value === skillName);
    const updated = this.pageItems().find((option) => option.value === skillName);
    if (!current || !updated) return;
    current.name = updated.name;
    current.description = updated.description;
    this.list.requestRender();
  }

  renderChrome() {
    const nav = TUI_PAGES.map((item) => (
      item.id === this.page
        ? `[${bindingLabel(this.bindings, `page.${item.id}`)} ${item.label}]`
        : `${bindingLabel(this.bindings, `page.${item.id}`)} ${item.label}`
    )).join('   ');
    this.navText.content = nav;
    if (this.snapshot) {
      const pending = pendingDeviceCount(this.snapshot.devices);
      this.headerMeta.content = `${this.config.deviceId}  ·  ${this.snapshot.skills.length} skills${pending ? `  ·  ${pending} pending` : ''}`;
    }
    const key = (action) => bindingLabel(this.bindings, action) || 'unbound';
    const modeHints = {
      edit: this.editorMode === 'insert'
        ? `INSERT   ${key('editor.normal')} normal   ${key('editor.save')} save`
        : `NORMAL   ${key('editor.move.left')}/${key('editor.move.down')}/${key('editor.move.up')}/${key('editor.move.right')} move   ${key('editor.insert.before')}/${key('editor.insert.after')} insert   ${key('editor.save')} save   ${key('editor.cancel')} close`,
      search: `type to filter   ${key('activate')} keep   ${key('close')} clear`,
      confirm: `${key('move.up')}/${key('move.down')} choose   ${key('activate')} apply   ${key('close')} cancel`,
      palette: `${key('palette.move.up')}/${key('palette.move.down')} choose   ${key('activate')} run   ${key('close')} close`,
      targets: `${key('move.up')}/${key('move.down')} choose   ${key('toggle')} toggle   ${key('activate')} apply   ${key('close')} cancel`,
      help: `${key('close')} close`,
    };
    const pageHints = {
      skills: `${key('move.down')}/${key('move.up')} move   ${key('focus.list')}/${key('focus.detail')} pane   ${key('activate')} install   ${key('edit')} edit   ${key('search')} filter`,
      targets: `${key('move.down')}/${key('move.up')} move   ${key('focus.list')}/${key('focus.detail')} pane   ${key('toggle')} auto-adopt   ${key('sync')} sync`,
      settings: `${key('move.down')}/${key('move.up')} move   ${key('focus.list')}/${key('focus.detail')} pane   ${key('activate')} run   ${key('commands')} commands`,
      devices: `${key('move.down')}/${key('move.up')} move/scroll   ${key('focus.list')}/${key('focus.detail')} pane   ${key('sync')} sync   ${key('commands')} commands`,
    };
    const hints = modeHints[this.mode] || pageHints[this.page];
    this.footerHints.content = hints;
    this.footerStatus.content = this.status.message;
    this.footerStatus.fg = COLORS[this.status.tone] || COLORS.muted;
  }

  setStatus(message, tone = 'muted') {
    this.status = { message, tone };
    this.renderChrome();
  }

  deviceAutoAdoptState() {
    const values = Object.values(this.snapshot?.localDevice?.targets || {}).map((target) => Boolean(target.auto_import));
    if (!values.length || values.every((value) => !value)) return 'off';
    if (values.every(Boolean)) return 'on';
    return 'mixed';
  }

  async perform(label, operation) {
    if (this.busy) return;
    this.busy = true;
    this.setStatus(label, 'warning');
    try {
      const message = await operation();
      if (!this.exitWhenIdle) await this.reload({ message: message || 'Done' });
    } catch (error) {
      if (!this.exitWhenIdle) {
        await this.reload({ refreshRegistry: true }).catch(() => {});
        this.setStatus(error.message, 'danger');
      }
    } finally {
      await this.finishBusy();
    }
  }

  async finishBusy() {
    this.busy = false;
    this.cancelRequested = false;
    if (this.exitWhenIdle && !this.exiting) {
      await this.exit('quit');
      return;
    }
    if (this.mode === 'browse') this.setBrowseFocus(this.focusArea);
  }

  setPage(page) {
    if (!TUI_PAGES.some((candidate) => candidate.id === page) || this.mode !== 'browse') return;
    this.page = page;
    this.focusArea = 'list';
    this.query = page === 'skills' ? this.query : '';
    this.configureWorkspaceLayout();
    this.updateList({ preserveSelection: true });
    this.setBrowseFocus('list');
  }

  setBrowseFocus(area) {
    if (this.mode !== 'browse' || !['list', 'detail'].includes(area)) return;
    this.focusArea = area;
    if (area === 'list') {
      this.previewScroll.blur();
      this.list.focus();
    } else {
      this.list.blur();
      this.previewScroll.focus();
    }
    this.listPane.borderColor = area === 'list' ? COLORS.borderActive : COLORS.border;
    this.detailHeader.borderColor = area === 'detail' ? COLORS.borderActive : COLORS.border;
    this.renderChrome();
  }

  openSearch() {
    if (this.page !== 'skills' || this.mode !== 'browse') return;
    this.mode = 'search';
    this.searchBar.visible = true;
    this.searchInput.value = this.query;
    this.searchInput.focus();
    this.renderChrome();
  }

  closeSearch({ clear = false } = {}) {
    if (this.mode !== 'search') return;
    if (clear) {
      this.query = '';
      this.searchInput.value = '';
    }
    this.mode = 'browse';
    this.searchBar.visible = false;
    this.updateList({ preserveSelection: true });
    this.setBrowseFocus('list');
  }

  async beginEdit() {
    if (this.page !== 'skills' || this.mode !== 'browse' || this.busy) return;
    const skillName = this.list.getSelectedOption()?.value;
    if (!skillName) return;
    this.busy = true;
    this.setStatus('Opening editor…', 'warning');
    try {
      const document = await loadSkillDocument({ vaultPath: this.config.repoPath, skillName });
      this.documents.set(skillName, document);
      this.activeDocument = document;
      this.openEditor(document);
      this.setStatus(`Editing ${skillName}`, 'warning');
    } catch (error) {
      this.setStatus(error.message, 'danger');
    } finally {
      await this.finishBusy();
    }
  }

  openEditor(document) {
    this.mode = 'edit';
    this.editorMode = 'normal';
    this.discardWarningContent = null;
    this.listPane.visible = false;
    this.detailPane.visible = false;
    this.editorPane = box(this.renderer, {
      id: 'editor-pane',
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      backgroundColor: COLORS.bg,
    });
    this.editorHeader = box(this.renderer, {
      height: 2,
      flexShrink: 0,
      flexDirection: 'row',
      alignItems: 'center',
      border: ['bottom'],
      borderColor: COLORS.border,
      backgroundColor: COLORS.surface,
      paddingX: 1,
    });
    this.editorModeText = text(this.renderer, {
      content: '',
      width: 10,
      height: 1,
      attributes: 1,
    });
    this.editorTitle = text(this.renderer, {
      content: `${document.name}  ·  ${document.relativePath}`,
      fg: COLORS.muted,
      height: 1,
      flexGrow: 1,
    });
    this.editorHeader.add(this.editorModeText);
    this.editorHeader.add(this.editorTitle);
    this.editorPane.add(this.editorHeader);
    this.editor = new TextareaRenderable(this.renderer, {
      id: 'skill-editor',
      width: '100%',
      height: '100%',
      initialValue: document.content,
      backgroundColor: COLORS.bg,
      focusedBackgroundColor: COLORS.bg,
      textColor: COLORS.text,
      focusedTextColor: COLORS.text,
      selectionBg: COLORS.accentSoft,
      cursorColor: COLORS.accent,
      wrapMode: 'word',
      tabIndicatorColor: COLORS.faint,
      syntaxStyle: this.theme,
      padding: 1,
      traits: { capture: ['escape', 'tab'] },
    });
    this.editorPane.add(this.editor);
    this.workspace.add(this.editorPane);
    this.editor.focus();
    this.renderEditorMode();
    this.renderChrome();
  }

  renderEditorMode() {
    if (!this.editor) return;
    const insert = this.editorMode === 'insert';
    this.editorModeText.content = insert ? ' INSERT ' : ' NORMAL ';
    this.editorModeText.fg = insert ? COLORS.success : COLORS.accent;
    this.editor.cursorStyle = { style: insert ? 'line' : 'block', blinking: insert };
  }

  enterInsertMode(action) {
    if (!this.editor || this.editorMode !== 'normal') return;
    if (action === 'editor.insert.after') this.editor.moveCursorRight();
    if (action === 'editor.insert.line-start') this.editor.gotoLineHome();
    if (action === 'editor.insert.line-end') this.editor.gotoLineEnd();
    if (action === 'editor.insert.below') {
      this.editor.gotoLineEnd();
      this.editor.newLine();
    }
    if (action === 'editor.insert.above') {
      this.editor.gotoLineHome();
      this.editor.newLine();
      this.editor.moveCursorUp();
    }
    this.editorMode = 'insert';
    this.discardWarningContent = null;
    this.renderEditorMode();
    this.renderChrome();
  }

  handleEditorKey(key) {
    if (keyMatches(this.bindings, 'editor.save', key)) {
      key.preventDefault();
      void this.saveEditor();
      return;
    }
    if (this.editorMode === 'insert') {
      if (keyMatches(this.bindings, 'editor.normal', key)) {
        key.preventDefault();
        this.editorMode = 'normal';
        this.renderEditorMode();
        this.renderChrome();
      }
      return;
    }

    key.preventDefault();
    if (keyMatches(this.bindings, 'editor.cancel', key)) return this.closeEditor();
    const insertAction = [
      'editor.insert.before',
      'editor.insert.after',
      'editor.insert.line-start',
      'editor.insert.line-end',
      'editor.insert.below',
      'editor.insert.above',
    ].find((action) => keyMatches(this.bindings, action, key));
    if (insertAction) return this.enterInsertMode(insertAction);
    if (keyMatches(this.bindings, 'editor.move.left', key)) return this.editor.moveCursorLeft();
    if (keyMatches(this.bindings, 'editor.move.down', key)) return this.editor.moveCursorDown();
    if (keyMatches(this.bindings, 'editor.move.up', key)) return this.editor.moveCursorUp();
    if (keyMatches(this.bindings, 'editor.move.right', key)) return this.editor.moveCursorRight();
    if (keyMatches(this.bindings, 'editor.move.word-forward', key)) return this.editor.moveWordForward();
    if (keyMatches(this.bindings, 'editor.move.word-backward', key)) return this.editor.moveWordBackward();
    if (keyMatches(this.bindings, 'editor.move.line-start', key)) return this.editor.gotoLineHome();
    if (keyMatches(this.bindings, 'editor.move.line-end', key)) return this.editor.gotoLineEnd();
    if (keyMatches(this.bindings, 'editor.move.buffer-start', key)) return this.editor.gotoBufferHome();
    if (keyMatches(this.bindings, 'editor.move.buffer-end', key)) return this.editor.gotoBufferEnd();
    if (keyMatches(this.bindings, 'editor.delete', key)) return this.editor.deleteChar();
    if (keyMatches(this.bindings, 'editor.delete.to-line-end', key)) return this.editor.deleteToLineEnd();
    if (keyMatches(this.bindings, 'editor.undo', key)) return this.editor.undo();
    if (keyMatches(this.bindings, 'editor.redo', key)) return this.editor.redo();
  }

  closeEditor() {
    if (this.mode !== 'edit') return;
    const content = this.editor.plainText;
    if (content !== this.activeDocument.content && this.discardWarningContent !== content) {
      this.discardWarningContent = content;
      this.setStatus(`Unsaved changes · press ${bindingLabel(this.bindings, 'editor.cancel')} again to discard`, 'warning');
      this.editor.focus();
      return;
    }
    this.dismissEditor();
    this.setStatus('Edit cancelled', 'muted');
  }

  dismissEditor() {
    this.editor.blur();
    this.workspace.remove(this.editorPane);
    this.editorPane.destroyRecursively();
    this.editorPane = null;
    this.editorHeader = null;
    this.editorModeText = null;
    this.editorTitle = null;
    this.editor = null;
    this.editorMode = null;
    this.discardWarningContent = null;
    this.listPane.visible = true;
    this.detailPane.visible = true;
    this.mode = 'browse';
    this.setBrowseFocus('list');
  }

  async saveEditor() {
    if (this.mode !== 'edit' || this.busy) return;
    const document = this.activeDocument;
    const content = this.editor.plainText;
    if (content === document.content) {
      this.closeEditor();
      this.setStatus('No changes to save', 'muted');
      return;
    }
    this.busy = true;
    this.setStatus('Saving and syncing vault…', 'warning');
    let saved;
    try {
      saved = await saveSkillDocument({
        vaultPath: this.config.repoPath,
        skillName: document.name,
        content,
        expectedHash: document.hash,
      });
    } catch (error) {
      if (error.fileSaved) {
        if (this.exitWhenIdle) {
          await this.finishBusy();
          return;
        }
        const current = await loadSkillDocument({
          vaultPath: this.config.repoPath,
          skillName: document.name,
        }).catch(() => null);
        if (current) {
          this.documents.set(current.name, current);
          this.activeDocument = current;
        }
        this.dismissEditor();
        this.setStatus(`Saved locally · metadata refresh failed: ${error.message}`, 'danger');
        await this.finishBusy();
        return;
      }
      if (!this.exitWhenIdle) {
        this.setStatus(error.message, 'danger');
        this.editor.focus();
      }
      await this.finishBusy();
      return;
    }

    this.documents.set(saved.name, saved);
    this.activeDocument = saved;
    this.dismissEditor();
    try {
      await syncVault({
        vaultPath: this.config.repoPath,
        deviceId: this.config.deviceId,
        pull: false,
      });
      await this.reload({ message: `Saved ${saved.name}` });
    } catch (error) {
      if (!this.exitWhenIdle) {
        await this.reload({ refreshRegistry: true }).catch(() => {});
        this.setStatus(`Saved locally · sync failed: ${error.message}`, 'danger');
      }
    } finally {
      await this.finishBusy();
    }
  }

  async openTargetPicker(skillName) {
    if (this.mode !== 'browse' || this.busy) return;
    const targetNames = Object.keys(this.snapshot.localDevice.targets || {}).sort();
    this.targetSelection = new Set(skillAssignmentTargets(this.snapshot.localDevice, skillName));
    this.targetSkillName = skillName;
    this.mode = 'targets';
    this.targetModal = this.createModal({ title: ` Install ${skillName} `, width: 58, height: Math.min(18, targetNames.length + 8) });
    this.targetModal.add(text(this.renderer, {
      content: 'Choose destinations. Empty selection uninstalls managed projections.',
      height: 2,
      flexShrink: 0,
      fg: COLORS.muted,
    }));
    this.targetList = new SelectRenderable(this.renderer, {
      id: 'target-picker',
      width: '100%',
      flexGrow: 1,
      options: ['global', ...targetNames].map((name) => ({
        value: name,
        name: `${this.targetSelection.has(name) ? '[x]' : '[ ]'} ${name}`,
        description: name === 'global'
          ? 'Device-level assignment without an agent projection'
          : this.snapshot.localDevice.targets[name].path,
      })),
      backgroundColor: COLORS.surface,
      focusedBackgroundColor: COLORS.surface,
      selectedBackgroundColor: COLORS.accentSoft,
      selectedTextColor: COLORS.selectedText,
      textColor: COLORS.text,
      descriptionColor: COLORS.muted,
      selectedDescriptionColor: COLORS.selectedMuted,
      showDescription: true,
      showSelectionIndicator: true,
    });
    this.targetModal.add(this.targetList);
    this.root.add(this.targetModal);
    this.targetList.focus();
    this.renderChrome();
  }

  toggleTargetChoice() {
    const option = this.targetList?.getSelectedOption();
    if (!option) return;
    if (this.targetSelection.has(option.value)) this.targetSelection.delete(option.value);
    else this.targetSelection.add(option.value);
    const index = this.targetList.getSelectedIndex();
    this.targetList.options = this.targetList.options.map((candidate) => ({
      ...candidate,
      name: `${this.targetSelection.has(candidate.value) ? '[x]' : '[ ]'} ${candidate.value}`,
    }));
    this.targetList.setSelectedIndex(index);
  }

  closeTargetPicker() {
    if (this.mode !== 'targets') return;
    this.targetList.blur();
    this.root.remove(this.targetModal);
    this.targetModal.destroyRecursively();
    this.targetModal = null;
    this.targetList = null;
    this.mode = 'browse';
    this.setBrowseFocus(this.focusArea);
  }

  async applyTargetPicker() {
    const skillName = this.targetSkillName;
    const targets = [...this.targetSelection].sort();
    this.closeTargetPicker();
    await this.perform(`Applying ${skillName}…`, async () => {
      if (targets.length) {
        await setSkillTargets({
          vaultPath: this.config.repoPath,
          deviceId: this.config.deviceId,
          skillName,
          targets,
        });
      } else {
        await uninstallSkillAndPrune({
          vaultPath: this.config.repoPath,
          deviceId: this.config.deviceId,
          skillName,
        });
      }
      await applyLinks({ vaultPath: this.config.repoPath, deviceId: this.config.deviceId });
      await syncVault({ vaultPath: this.config.repoPath, deviceId: this.config.deviceId, pull: false });
      return targets.length ? `Installed ${skillName}` : `Uninstalled ${skillName}`;
    });
  }

  createModal({ title, width, height }) {
    return box(this.renderer, {
      position: 'absolute',
      left: '50%',
      top: '50%',
      marginLeft: -Math.floor(width / 2),
      marginTop: -Math.floor(height / 2),
      width,
      height,
      zIndex: 100,
      flexDirection: 'column',
      border: true,
      borderStyle: 'rounded',
      borderColor: COLORS.borderActive,
      backgroundColor: COLORS.surface,
      title,
      titleColor: COLORS.accent,
      padding: 1,
      gap: 1,
    });
  }

  openConfirmation({ title, message, confirmLabel, onConfirm }) {
    if (this.mode !== 'browse' || this.busy) return;
    this.mode = 'confirm';
    this.confirmAction = onConfirm;
    this.confirmModal = this.createModal({
      title: ` ${title} `,
      width: Math.min(68, Math.max(48, this.renderer.width - 8)),
      height: 11,
    });
    this.confirmModal.add(text(this.renderer, {
      content: message,
      width: '100%',
      height: 3,
      flexShrink: 0,
      fg: COLORS.text,
    }));
    this.confirmList = new SelectRenderable(this.renderer, {
      id: 'confirmation',
      width: '100%',
      flexGrow: 1,
      options: [
        { value: 'cancel', name: 'Cancel', description: 'Leave the current setting unchanged' },
        { value: 'confirm', name: confirmLabel, description: 'Apply and sync this vault setting' },
      ],
      backgroundColor: COLORS.surface,
      focusedBackgroundColor: COLORS.surface,
      selectedBackgroundColor: COLORS.accentSoft,
      selectedTextColor: COLORS.selectedText,
      textColor: COLORS.text,
      descriptionColor: COLORS.muted,
      selectedDescriptionColor: COLORS.selectedMuted,
      showDescription: true,
      showSelectionIndicator: true,
    });
    this.confirmModal.add(this.confirmList);
    this.root.add(this.confirmModal);
    this.confirmList.focus();
    this.renderChrome();
  }

  closeConfirmation() {
    if (this.mode !== 'confirm') return;
    this.confirmList.blur();
    this.root.remove(this.confirmModal);
    this.confirmModal.destroyRecursively();
    this.confirmModal = null;
    this.confirmList = null;
    this.mode = 'browse';
    this.setBrowseFocus(this.focusArea);
  }

  async applyConfirmation() {
    const confirmed = this.confirmList?.getSelectedOption()?.value === 'confirm';
    const action = this.confirmAction;
    this.confirmAction = null;
    this.closeConfirmation();
    if (confirmed) await action();
  }

  openPalette() {
    if (this.mode !== 'browse' || this.busy) return;
    this.mode = 'palette';
    this.paletteCommands = [
      { value: 'sync', name: 'Sync now', description: 'Pull, apply, scan, commit, and push' },
      { value: 'scan', name: 'Scan local targets', description: 'Refresh inventory without pulling first' },
      { value: 'refresh', name: 'Refresh vault view', description: 'Reload skills, devices, and settings' },
      { value: 'advanced', name: 'Advanced management', description: 'Matrix, imports, packs, maintenance, connections, and targets' },
      { value: 'help', name: 'Keyboard help', description: 'Show every shortcut' },
      { value: 'quit', name: 'Quit SkillSync', description: 'Return to the shell' },
    ];
    this.paletteModal = this.createModal({ title: ' Commands ', width: Math.min(72, Math.max(48, this.renderer.width - 8)), height: 17 });
    this.paletteInput = new InputRenderable(this.renderer, {
      id: 'command-filter',
      value: '',
      placeholder: 'Type a command',
      width: '100%',
      height: 1,
      backgroundColor: COLORS.surfaceRaised,
      focusedBackgroundColor: COLORS.surfaceRaised,
      textColor: COLORS.text,
      focusedTextColor: COLORS.text,
      placeholderColor: COLORS.faint,
      onContentChange: () => this.filterPalette(),
    });
    this.paletteInput.on(InputRenderableEvents.ENTER, () => void this.runPaletteCommand());
    this.paletteList = new SelectRenderable(this.renderer, {
      id: 'command-list',
      width: '100%',
      flexGrow: 1,
      options: this.paletteCommands,
      backgroundColor: COLORS.surface,
      focusedBackgroundColor: COLORS.surface,
      selectedBackgroundColor: COLORS.accentSoft,
      selectedTextColor: COLORS.selectedText,
      textColor: COLORS.text,
      descriptionColor: COLORS.muted,
      selectedDescriptionColor: COLORS.selectedMuted,
      showDescription: true,
      showSelectionIndicator: true,
    });
    this.paletteModal.add(this.paletteInput);
    this.paletteModal.add(this.paletteList);
    this.root.add(this.paletteModal);
    this.paletteInput.focus();
    this.renderChrome();
  }

  filterPalette() {
    const query = this.paletteInput.value.toLowerCase().trim();
    this.paletteList.options = this.paletteCommands.filter((command) => (
      !query || `${command.name} ${command.description}`.toLowerCase().includes(query)
    ));
    this.paletteList.setSelectedIndex(0);
  }

  closePalette() {
    if (this.mode !== 'palette') return;
    this.paletteInput.blur();
    this.root.remove(this.paletteModal);
    this.paletteModal.destroyRecursively();
    this.paletteModal = null;
    this.paletteInput = null;
    this.paletteList = null;
    this.mode = 'browse';
    this.setBrowseFocus(this.focusArea);
  }

  async runPaletteCommand() {
    const command = this.paletteList?.getSelectedOption()?.value;
    if (!command) return;
    this.closePalette();
    await this.runAction(command);
  }

  async runAction(action) {
    if (action === 'quit') return this.exit('quit');
    if (action === 'advanced') return this.exit('advanced');
    if (action === 'help') return this.openHelp();
    if (action === 'refresh') {
      return this.perform('Refreshing vault…', async () => {
        await refreshChangedRegistryEntries(this.config.repoPath);
        return 'Vault refreshed';
      });
    }
    if (action === 'sync') {
      return this.perform('Syncing vault…', async () => {
        const result = await syncVault({ vaultPath: this.config.repoPath, deviceId: this.config.deviceId, pull: true });
        return result.pushed ? 'Synced and pushed changes' : 'Synced · no changes to push';
      });
    }
    if (action === 'scan') {
      return this.perform('Scanning local targets…', async () => {
        const result = await syncVault({ vaultPath: this.config.repoPath, deviceId: this.config.deviceId, pull: false });
        const adopted = result.autoImported?.length || 0;
        return adopted ? `Scan complete · adopted ${adopted}` : 'Scan complete';
      });
    }
  }

  openHelp() {
    if (this.mode !== 'browse') return;
    this.mode = 'help';
    this.helpModal = this.createModal({ title: ' Keyboard ', width: Math.min(84, Math.max(58, this.renderer.width - 8)), height: 27 });
    const key = (action) => bindingLabel(this.bindings, action) || 'unbound';
    const help = [
      [TUI_PAGES.map((page) => key(`page.${page.id}`)).join(' / '), 'Switch sections'],
      [`${key('move.down')} / ${key('move.up')}`, 'Move in a list or scroll the focused preview'],
      [`${key('focus.list')} / ${key('focus.detail')}`, 'Focus the left list or right preview'],
      [key('activate'), 'Choose install destinations or run an action'],
      [key('edit'), 'Open the selected canonical SKILL.md in NORMAL mode'],
      [`${key('editor.insert.before')} / ${key('editor.insert.after')} / ${key('editor.insert.line-start')} / ${key('editor.insert.line-end')}`, 'Enter INSERT mode before/after the cursor or line'],
      [`${key('editor.insert.below')} / ${key('editor.insert.above')}`, 'Open a line below/above and enter INSERT mode'],
      [`${key('editor.move.left')} / ${key('editor.move.down')} / ${key('editor.move.up')} / ${key('editor.move.right')}`, 'Move the editor cursor in NORMAL mode'],
      [`${key('editor.move.word-forward')} / ${key('editor.move.word-backward')} / ${key('editor.move.line-start')} / ${key('editor.move.line-end')}`, 'Move by word or line in NORMAL mode'],
      [`${key('editor.delete')} / ${key('editor.delete.to-line-end')} / ${key('editor.undo')} / ${key('editor.redo')}`, 'Delete, delete to end, undo, redo'],
      [key('editor.normal'), 'Return to NORMAL mode'],
      [key('editor.save'), 'Save an edit and sync the vault'],
      [key('search'), 'Filter skills'],
      [key('toggle'), 'Toggle a target setting or install destination'],
      [key('sync'), 'Sync now'],
      [key('refresh'), 'Refresh the current view'],
      [key('commands'), 'Open command palette'],
      [key('close'), 'Close the current overlay'],
      [`${key('quit')} / ${key('force-quit')}`, 'Quit'],
    ];
    this.helpModal.add(text(this.renderer, {
      content: help.map(([key, description]) => `${key.padEnd(18)}${description}`).join('\n'),
      fg: COLORS.text,
      width: '100%',
      height: '100%',
      wrapMode: 'word',
    }));
    this.root.add(this.helpModal);
    this.renderChrome();
  }

  closeHelp() {
    if (this.mode !== 'help') return;
    this.root.remove(this.helpModal);
    this.helpModal.destroyRecursively();
    this.helpModal = null;
    this.mode = 'browse';
    this.setBrowseFocus(this.focusArea);
  }

  async runSelectedSetting() {
    const action = this.list.getSelectedOption()?.value;
    if (!action) return;
    if (['sync', 'scan', 'advanced'].includes(action)) return this.runAction(action);
    if (action === 'keybindings') {
      return this.perform('Reloading keybindings…', async () => {
        const preferences = await loadTuiPreferences(this.preferencesPath);
        this.bindings = preferences.keybindings;
        return 'Keybindings reloaded';
      });
    }
    if (action === 'auto-adopt') {
      const enabled = this.deviceAutoAdoptState() !== 'on';
      return this.perform('Updating auto-adopt…', async () => {
        await setDeviceAutoImport({
          vaultPath: this.config.repoPath,
          deviceId: this.config.deviceId,
          enabled,
        });
        await syncVault({ vaultPath: this.config.repoPath, deviceId: this.config.deviceId, pull: false });
        return `Auto-adopt ${enabled ? 'enabled' : 'disabled'}`;
      });
    }
    if (action === 'delete-unassigned') {
      const enabled = !this.snapshot.vaultConfig.policies.delete_unassigned_skills;
      const updatePolicy = () => this.perform('Updating vault policy…', async () => {
        await setVaultPolicy({
          vaultPath: this.config.repoPath,
          name: 'delete_unassigned_skills',
          enabled,
        });
        await syncVault({ vaultPath: this.config.repoPath, deviceId: this.config.deviceId, pull: false });
        return `Delete unassigned ${enabled ? 'enabled' : 'disabled'}`;
      });
      if (!enabled) return updatePolicy();
      return this.openConfirmation({
        title: 'Enable vault cleanup',
        message: 'Full syncs may remove skills after every device reports them unassigned and absent.',
        confirmLabel: 'Enable cleanup',
        onConfirm: updatePolicy,
      });
    }
  }

  async toggleCurrentTargetAutoAdopt() {
    if (this.page !== 'targets' || this.mode !== 'browse') return;
    const targetName = this.list.getSelectedOption()?.value;
    const target = this.snapshot.localDevice.targets[targetName];
    if (!target) return;
    await this.perform(`Updating ${targetName}…`, async () => {
      await setTargetAutoImport({
        vaultPath: this.config.repoPath,
        deviceId: this.config.deviceId,
        name: targetName,
        enabled: !target.auto_import,
      });
      await syncVault({ vaultPath: this.config.repoPath, deviceId: this.config.deviceId, pull: false });
      return `${targetName} auto-adopt ${target.auto_import ? 'disabled' : 'enabled'}`;
    });
  }

  configureWorkspaceLayout() {
    const narrow = this.renderer.width < 72;
    const compact = this.renderer.width < 86;
    const index = this.page === 'skills';

    this.list.showDescription = !index;
    this.list.showSelectionIndicator = true;
    this.list.showScrollIndicator = index;
    this.listHeader.paddingX = index ? 0 : 1;
    this.listCount.visible = !index;
    this.listTitle.attributes = 1;

    if (index) {
      const tableHeight = Math.max(9, Math.min(17, Math.floor(this.renderer.height * 0.4)));
      this.workspace.flexDirection = 'column';
      this.listPane.border = ['bottom'];
      this.listPane.width = '100%';
      this.listPane.height = tableHeight;
      this.listPane.minWidth = 0;
      this.listPane.maxWidth = '100%';
      this.detailPane.width = '100%';
      this.detailPane.height = '100%';
      this.detailPane.minWidth = 0;
      this.detailPane.flexDirection = narrow ? 'column' : 'row';
      this.detailHeader.width = narrow ? '100%' : '29%';
      this.detailHeader.height = narrow ? 6 : '100%';
      this.detailHeader.flexShrink = 0;
      this.detailHeader.border = narrow ? ['bottom'] : ['right'];
      this.detailHeader.justifyContent = 'flex-start';
      this.detailHeader.paddingX = 2;
      this.detailHeader.paddingY = 1;
      this.detailMeta.height = 'auto';
      this.previewScroll.width = narrow ? '100%' : '71%';
      this.previewScroll.height = '100%';
      this.previewScroll.paddingX = 2;
      this.previewScroll.paddingY = 1;
      return;
    }

    this.workspace.flexDirection = narrow ? 'column' : 'row';
    this.listPane.border = narrow ? ['bottom'] : ['right'];
    this.listPane.width = narrow ? '100%' : compact ? '40%' : '36%';
    this.listPane.height = narrow ? '45%' : '100%';
    this.listPane.minWidth = narrow ? 0 : compact ? 24 : 28;
    this.listPane.maxWidth = narrow ? '100%' : compact ? 36 : 52;
    this.detailPane.width = '100%';
    this.detailPane.height = narrow ? '55%' : '100%';
    this.detailPane.minWidth = narrow ? 0 : 32;
    this.detailPane.flexDirection = 'column';
    this.detailHeader.width = '100%';
    this.detailHeader.height = 3;
    this.detailHeader.flexShrink = 0;
    this.detailHeader.border = ['bottom'];
    this.detailHeader.justifyContent = 'center';
    this.detailHeader.paddingX = 2;
    this.detailHeader.paddingY = 0;
    this.detailMeta.height = 2;
    this.previewScroll.width = '100%';
    this.previewScroll.height = '100%';
    this.previewScroll.paddingX = 2;
    this.previewScroll.paddingY = 1;
  }

  updateResponsiveLayout() {
    const narrow = this.renderer.width < 72;
    this.brand.visible = !narrow;
    this.workspace.rowGap = 0;
    this.workspace.columnGap = 0;
    this.configureWorkspaceLayout();
    this.headerMeta.visible = this.renderer.width >= 76;
    if (this.snapshot && this.mode === 'browse') this.updateList({ preserveSelection: true });
  }

  async handleKey(key) {
    if (key.eventType === 'release') return;
    const forceQuit = keyMatches(this.bindings, 'force-quit', key);
    const quit = this.mode === 'browse' && keyMatches(this.bindings, 'quit', key);
    if (forceQuit || quit) {
      key.preventDefault();
      if (this.busy) {
        if (!this.cancelRequested) {
          this.cancelRequested = true;
          const quitKey = [
            ...(this.mode === 'browse' ? this.bindings.quit : []),
            ...this.bindings['force-quit'],
          ].join(' or ');
          this.setStatus(`Operation running · press ${quitKey} again to cancel and quit`, 'warning');
          return;
        }
        this.exitWhenIdle = true;
        const cancelled = cancelRunningCommands();
        this.setStatus(cancelled ? 'Cancelling operation…' : 'Finishing operation…', 'warning');
        return;
      }
      await this.exit('quit');
      return;
    }
    if (this.mode === 'edit') {
      this.handleEditorKey(key);
      return;
    }
    if (this.mode === 'search') {
      if (keyMatches(this.bindings, 'close', key)) {
        key.preventDefault();
        this.closeSearch({ clear: true });
      } else if (keyMatches(this.bindings, 'activate', key)) {
        key.preventDefault();
        this.closeSearch();
      }
      return;
    }
    if (this.mode === 'confirm') {
      if (keyMatches(this.bindings, 'close', key)) {
        key.preventDefault();
        this.confirmAction = null;
        this.closeConfirmation();
      } else if (keyMatches(this.bindings, 'activate', key)) {
        key.preventDefault();
        await this.applyConfirmation();
      } else if (keyMatches(this.bindings, 'move.up', key)) {
        key.preventDefault();
        this.confirmList.moveUp();
      } else if (keyMatches(this.bindings, 'move.down', key)) {
        key.preventDefault();
        this.confirmList.moveDown();
      }
      return;
    }
    if (this.mode === 'palette') {
      if (keyMatches(this.bindings, 'close', key)) {
        key.preventDefault();
        this.closePalette();
      } else if (keyMatches(this.bindings, 'activate', key)) {
        key.preventDefault();
        await this.runPaletteCommand();
      } else if (keyMatches(this.bindings, 'palette.move.up', key)) {
        key.preventDefault();
        this.paletteList.moveUp();
      } else if (keyMatches(this.bindings, 'palette.move.down', key)) {
        key.preventDefault();
        this.paletteList.moveDown();
      }
      return;
    }
    if (this.mode === 'targets') {
      if (keyMatches(this.bindings, 'close', key)) {
        key.preventDefault();
        this.closeTargetPicker();
      } else if (keyMatches(this.bindings, 'toggle', key)) {
        key.preventDefault();
        this.toggleTargetChoice();
      } else if (keyMatches(this.bindings, 'activate', key)) {
        key.preventDefault();
        await this.applyTargetPicker();
      } else if (keyMatches(this.bindings, 'move.up', key)) {
        key.preventDefault();
        this.targetList.moveUp();
      } else if (keyMatches(this.bindings, 'move.down', key)) {
        key.preventDefault();
        this.targetList.moveDown();
      }
      return;
    }
    if (this.mode === 'help') {
      if (keyMatches(this.bindings, 'close', key)
        || keyMatches(this.bindings, 'help', key)
        || keyMatches(this.bindings, 'activate', key)) {
        key.preventDefault();
        this.closeHelp();
      }
      return;
    }
    if (this.busy) return;

    const page = TUI_PAGES.find((candidate) => keyMatches(this.bindings, `page.${candidate.id}`, key));
    if (page) {
      key.preventDefault();
      this.setPage(page.id);
      return;
    }
    if (keyMatches(this.bindings, 'commands', key)) {
      key.preventDefault();
      this.openPalette();
      return;
    }
    if (keyMatches(this.bindings, 'help', key)) {
      key.preventDefault();
      this.openHelp();
      return;
    }
    if (keyMatches(this.bindings, 'search', key) && this.page === 'skills') {
      key.preventDefault();
      this.openSearch();
      return;
    }
    if (keyMatches(this.bindings, 'edit', key)) {
      key.preventDefault();
      await this.beginEdit();
      return;
    }
    if (keyMatches(this.bindings, 'sync', key)) {
      key.preventDefault();
      await this.runAction('sync');
      return;
    }
    if (keyMatches(this.bindings, 'refresh', key)) {
      key.preventDefault();
      await this.runAction('refresh');
      return;
    }
    if (keyMatches(this.bindings, 'focus.list', key)) {
      key.preventDefault();
      this.setBrowseFocus('list');
      return;
    }
    if (keyMatches(this.bindings, 'focus.detail', key)) {
      key.preventDefault();
      this.setBrowseFocus('detail');
      return;
    }
    if (keyMatches(this.bindings, 'toggle', key) && this.page === 'targets') {
      key.preventDefault();
      await this.toggleCurrentTargetAutoAdopt();
      return;
    }
    if (keyMatches(this.bindings, 'activate', key)) {
      key.preventDefault();
      if (this.page === 'skills') {
        await this.openTargetPicker(this.list.getSelectedOption()?.value);
      } else if (this.page === 'settings') {
        await this.runSelectedSetting();
      } else {
        this.setBrowseFocus('detail');
      }
      return;
    }
    if (keyMatches(this.bindings, 'move.down', key)) {
      key.preventDefault();
      if (this.focusArea === 'detail') this.previewScroll.scrollBy(1);
      else this.list.moveDown();
      return;
    }
    if (keyMatches(this.bindings, 'move.up', key)) {
      key.preventDefault();
      if (this.focusArea === 'detail') this.previewScroll.scrollBy(-1);
      else this.list.moveUp();
    }
  }

  async exit(reason) {
    if (this.exiting) return;
    this.exiting = true;
    this.renderer.keyInput.off('keypress', this.handleKey);
    const highlights = pendingHighlights(this.root);
    if (this.markdown) this.markdown.content = '';
    await Promise.allSettled(highlights);
    await Promise.allSettled(pendingHighlights(this.root));
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.root.destroyRecursively();
    this.theme.destroy();
    this.renderer.destroy();
    this.onExit(reason);
  }
}

export async function createSkillSyncTui({ config }) {
  const preferences = await loadTuiPreferences();
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    clearOnShutdown: true,
    backgroundColor: COLORS.bg,
    targetFps: 30,
    maxFps: 60,
    useMouse: true,
    enableMouseMovement: false,
    openConsoleOnError: false,
    screenMode: 'alternate-screen',
  });
  return new Promise((resolve, reject) => {
    const app = new SkillSyncTui({ config, renderer, onExit: resolve, preferences });
    app.start().catch((error) => {
      renderer.destroy();
      reject(error);
    });
  });
}
