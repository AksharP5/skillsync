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
  countDeviceSkills,
  filterSkillNames,
  pendingDeviceCount,
  skillAssignmentTargets,
  splitSkillDocument,
  targetDetectedCount,
  truncateLine,
} from './model.js';

const COLORS = {
  bg: '#0A0E13',
  surface: '#101720',
  surfaceRaised: '#17212B',
  border: '#263443',
  borderActive: '#52D3C6',
  text: '#DCE7EA',
  muted: '#7E909C',
  faint: '#50616D',
  accent: '#52D3C6',
  accentSoft: '#163A3B',
  success: '#8BD49C',
  warning: '#E6BE77',
  danger: '#F08A8A',
};

function syntaxStyle() {
  return SyntaxStyle.fromStyles({
    default: { fg: COLORS.text },
    'markup.heading': { fg: COLORS.accent, bold: true },
    'markup.heading.1': { fg: '#80E4D9', bold: true },
    'markup.heading.2': { fg: '#6CD8CE', bold: true },
    'markup.bold': { fg: COLORS.text, bold: true },
    'markup.italic': { fg: '#B6C7CE', italic: true },
    'markup.raw': { fg: '#A7C7E7', bg: '#111D28' },
    'markup.link': { fg: '#7EB6E8', underline: true },
    'markup.list': { fg: COLORS.warning },
    comment: { fg: COLORS.muted, italic: true },
    string: { fg: '#A8D59D' },
    keyword: { fg: '#D4A5E7' },
    function: { fg: '#8FC9F0' },
    number: { fg: '#E7C787' },
    punctuation: { fg: '#91A2AC' },
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

function pendingHighlights(renderable) {
  const own = renderable instanceof CodeRenderable ? [renderable.highlightingDone] : [];
  return [
    ...own,
    ...renderable.getChildren().flatMap((child) => pendingHighlights(child)),
  ];
}

export class SkillSyncTui {
  constructor({ config, renderer, onExit }) {
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
    this.theme = syntaxStyle();
    this.handleKey = this.handleKey.bind(this);
  }

  async start() {
    this.buildLayout();
    this.updateResponsiveLayout();
    this.renderer.keyInput.on('keypress', this.handleKey);
    this.renderer.on(CliRenderEvents.RESIZE, () => this.updateResponsiveLayout());
    await this.reload({ refreshRegistry: true });
    this.list.focus();
  }

  buildLayout() {
    this.root = box(this.renderer, {
      id: 'skillsync-root',
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      paddingX: 1,
    });
    this.renderer.root.add(this.root);

    const header = box(this.renderer, {
      height: 3,
      flexShrink: 0,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      border: ['bottom'],
      borderColor: COLORS.border,
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
      height: 3,
      flexShrink: 0,
      flexDirection: 'row',
      alignItems: 'center',
      visible: false,
      border: ['bottom'],
      borderColor: COLORS.borderActive,
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
      columnGap: 1,
      paddingY: 1,
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
      border: true,
      borderStyle: 'rounded',
      borderColor: COLORS.border,
      focusedBorderColor: COLORS.borderActive,
      title: ' Skills ',
      titleColor: COLORS.muted,
      padding: 1,
    });
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
      selectedTextColor: '#C9FFF8',
      descriptionColor: COLORS.muted,
      selectedDescriptionColor: '#91BDBA',
      showDescription: true,
      showSelectionIndicator: true,
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
      border: true,
      borderStyle: 'rounded',
      borderColor: COLORS.border,
      title: ' Preview ',
      titleColor: COLORS.muted,
      padding: 1,
    });
    this.detailMeta = text(this.renderer, {
      content: '',
      height: 2,
      flexShrink: 0,
      fg: COLORS.muted,
      wrapMode: 'word',
    });
    this.detailPane.add(this.detailMeta);
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
          fg: '#A7C7E7',
          bg: '#111D28',
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
    this.snapshot = {
      registry,
      localDevice,
      devices,
      vaultConfig,
      skills: Object.keys(registry.skills).sort(),
    };
    if (selected) this.selectedByPage.set(this.page, selected);
    if (message) this.setStatus(message, 'success');
    else if (this.status.message === 'Loading vault…') this.setStatus('Ready', 'muted');
    this.updateList({ preserveSelection: true });
    this.renderChrome();
  }

  pageItems() {
    if (!this.snapshot) return [];
    if (this.page === 'skills') {
      return filterSkillNames(this.snapshot.skills, this.query, this.documents).map((name) => {
        const document = this.documents.get(name);
        const targets = skillAssignmentTargets(this.snapshot.localDevice, name);
        const description = splitSkillDocument(document?.content).description;
        return {
          value: name,
          name: `${targets.length ? '+' : ' '} ${name}`,
          description: truncateLine(description || (targets.length ? `Installed: ${targets.join(', ')}` : 'Vault skill'), 58),
        };
      });
    }
    if (this.page === 'devices') {
      return this.snapshot.devices.map((device) => ({
        value: device.device_id,
        name: `${device.device_id === this.config.deviceId ? '+' : ' '} ${device.display_name}`,
        description: `${countDeviceSkills(device)} skills · ${device.desired_generation === device.applied_generation ? 'synced' : 'pending'}`,
      }));
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
    this.listPane.title = ` ${TUI_PAGES.find((page) => page.id === this.page)?.label || 'Skills'} `;
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
      const assignments = [...new Set([
        ...Object.keys(device.installed || {}),
        ...(device.global_installed || []),
      ])].sort();
      const targets = Object.entries(device.targets || {}).map(([name, target]) => (
        `- **${name}** · ${target.mode} · ${target.auto_import ? 'auto-adopt on' : 'auto-adopt off'}${target.path ? ` · \`${target.path}\`` : ''}`
      ));
      this.detailPane.title = ' Device ';
      this.detailMeta.content = `${device.display_name}\n${device.device_id === this.config.deviceId ? 'This device' : 'Remote device'}`;
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
        `## Assigned skills (${assignments.length})`,
        '',
        ...(assignments.length ? assignments.map((name) => `- ${name} · ${skillAssignmentTargets(device, name).join(', ')}`) : ['_No assigned skills._']),
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
        ...(detected.length ? detected.map((skill) => `- ${skill.name}${skill.in_vault ? ' · in vault' : ' · local only'}`) : ['_Nothing detected._']),
        '',
        'Press `space` to toggle auto-adopt for this target.',
      ].join('\n');
      return;
    }

    const descriptions = {
      sync: '# Sync now\n\nPull the latest vault, apply desired assignments, auto-adopt new local skills, refresh projections, commit real changes, and push.',
      scan: '# Scan local targets\n\nRun the local reconciliation pass without pulling first.',
      'auto-adopt': '# Auto-adopt\n\nWhen enabled, genuinely new skill folders created inside managed agent targets are adopted into the private vault on the next sync.',
      'delete-unassigned': '# Delete fully unassigned skills\n\nWhen enabled, SkillSync only removes a skill after every device has removed its assignment and reported the local copy gone.',
      advanced: '# Advanced management\n\nOpen the complete interactive menu for the skill matrix, remote assignments, add/import flows, packs, groups, deletion, diagnostics, background service, vault connections, global instructions, and targets.',
    };
    this.detailPane.title = ' Action ';
    this.detailMeta.content = '';
    this.markdown.content = descriptions[value] || '';
  }

  renderSkillDocument(skillName, document) {
    this.activeDocument = document;
    const { body } = splitSkillDocument(document.content);
    const assigned = skillAssignmentTargets(this.snapshot.localDevice, skillName);
    const updated = document.updatedAt ? new Date(document.updatedAt).toLocaleString() : 'unknown';
    this.detailMeta.content = `${skillName}  ·  ${assigned.length ? `installed in ${assigned.join(', ')}` : 'not installed here'}\n${document.relativePath}  ·  updated ${updated}`;
    this.markdown.content = body.trim() || '_This skill has no Markdown body._';
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
      item.id === this.page ? `[${item.key} ${item.label}]` : `${item.key} ${item.label}`
    )).join('   ');
    this.navText.content = nav;
    if (this.snapshot) {
      const pending = pendingDeviceCount(this.snapshot.devices);
      this.headerMeta.content = `${this.config.deviceId}  ·  ${this.snapshot.skills.length} skills${pending ? `  ·  ${pending} pending` : ''}`;
    }
    const modeHints = {
      edit: 'ctrl+s save   esc cancel   ctrl+z undo',
      search: 'type to filter   enter keep   esc clear',
      confirm: '↑↓ choose   enter apply   esc cancel',
      palette: '↑↓ choose   enter run   esc close',
      targets: '↑↓ choose   space toggle   enter apply   esc cancel',
      help: 'esc close',
    };
    const pageHints = {
      skills: '↑↓ browse   enter install   e edit   / filter   s sync   ctrl+p commands   ? help',
      targets: '↑↓ browse   space auto-adopt   s sync   ctrl+p commands   ? help',
      settings: '↑↓ browse   enter run   ctrl+p commands   ? help',
      devices: '↑↓ browse   s sync   ctrl+p commands   ? help',
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
    if (this.mode === 'browse') this.list.focus();
  }

  setPage(page) {
    if (!TUI_PAGES.some((candidate) => candidate.id === page) || this.mode !== 'browse') return;
    this.page = page;
    this.query = page === 'skills' ? this.query : '';
    this.listPane.title = ` ${TUI_PAGES.find((item) => item.id === page).label} `;
    this.updateList({ preserveSelection: true });
    this.list.focus();
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
    this.list.focus();
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
    this.discardWarningContent = null;
    this.listPane.visible = false;
    this.detailPane.visible = false;
    this.editorPane = box(this.renderer, {
      id: 'editor-pane',
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      border: true,
      borderStyle: 'rounded',
      borderColor: COLORS.borderActive,
      title: ` Edit ${document.name} `,
      titleColor: COLORS.accent,
      padding: 1,
    });
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
      traits: { capture: ['escape', 'tab'] },
    });
    this.editorPane.add(this.editor);
    this.workspace.add(this.editorPane);
    this.editor.focus();
    this.renderChrome();
  }

  closeEditor() {
    if (this.mode !== 'edit') return;
    const content = this.editor.plainText;
    if (content !== this.activeDocument.content && this.discardWarningContent !== content) {
      this.discardWarningContent = content;
      this.setStatus('Unsaved changes · press esc again to discard', 'warning');
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
    this.editor = null;
    this.discardWarningContent = null;
    this.listPane.visible = true;
    this.detailPane.visible = true;
    this.mode = 'browse';
    this.list.focus();
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
      selectedTextColor: '#C9FFF8',
      textColor: COLORS.text,
      descriptionColor: COLORS.muted,
      selectedDescriptionColor: '#91BDBA',
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
    this.list.focus();
    this.renderChrome();
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
      selectedTextColor: '#C9FFF8',
      textColor: COLORS.text,
      descriptionColor: COLORS.muted,
      selectedDescriptionColor: '#91BDBA',
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
    this.list.focus();
    this.renderChrome();
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
      selectedTextColor: '#C9FFF8',
      textColor: COLORS.text,
      descriptionColor: COLORS.muted,
      selectedDescriptionColor: '#91BDBA',
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
    this.list.focus();
    this.renderChrome();
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
    this.helpModal = this.createModal({ title: ' Keyboard ', width: Math.min(76, Math.max(52, this.renderer.width - 8)), height: 22 });
    const help = [
      ['1–4', 'Switch Skills, Devices, Targets, Settings'],
      ['↑ / ↓ or j / k', 'Move through the current list'],
      ['enter', 'Choose install destinations or run an action'],
      ['e', 'Edit the selected canonical SKILL.md'],
      ['ctrl+s', 'Save an edit and sync the vault'],
      ['/', 'Filter skills'],
      ['space', 'Toggle a target setting or install destination'],
      ['s', 'Sync now'],
      ['r', 'Refresh the current view'],
      ['ctrl+p', 'Open command palette'],
      ['esc', 'Close the current overlay'],
      ['q / ctrl+c', 'Quit'],
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
    this.list.focus();
    this.renderChrome();
  }

  async runSelectedSetting() {
    const action = this.list.getSelectedOption()?.value;
    if (!action) return;
    if (['sync', 'scan', 'advanced'].includes(action)) return this.runAction(action);
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

  updateResponsiveLayout() {
    const narrow = this.renderer.width < 72;
    const compact = this.renderer.width < 86;
    this.brand.visible = !narrow;
    this.workspace.flexDirection = narrow ? 'column' : 'row';
    this.workspace.rowGap = narrow ? 1 : 0;
    this.workspace.columnGap = narrow ? 0 : 1;
    this.listPane.width = narrow ? '100%' : compact ? '40%' : '34%';
    this.listPane.height = narrow ? '42%' : '100%';
    this.listPane.minWidth = narrow ? 0 : compact ? 24 : 28;
    this.listPane.maxWidth = narrow ? '100%' : compact ? 34 : 46;
    this.detailPane.width = '100%';
    this.detailPane.height = narrow ? 'auto' : '100%';
    this.detailPane.minWidth = narrow ? 0 : 32;
    this.headerMeta.visible = this.renderer.width >= 76;
  }

  async handleKey(key) {
    if (key.eventType === 'release') return;
    if ((key.ctrl && key.name === 'c') || (this.mode === 'browse' && key.name === 'q')) {
      key.preventDefault();
      if (this.busy) {
        if (!this.cancelRequested) {
          this.cancelRequested = true;
          const quitKey = this.mode === 'browse' ? 'q or ctrl+c' : 'ctrl+c';
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
      if (key.ctrl && key.name === 's') {
        key.preventDefault();
        await this.saveEditor();
      } else if (key.name === 'escape') {
        key.preventDefault();
        this.closeEditor();
      }
      return;
    }
    if (this.mode === 'search') {
      if (key.name === 'escape') {
        key.preventDefault();
        this.closeSearch({ clear: true });
      }
      return;
    }
    if (this.mode === 'confirm') {
      if (key.name === 'escape') {
        key.preventDefault();
        this.confirmAction = null;
        this.closeConfirmation();
      } else if (key.name === 'return' || key.name === 'enter') {
        key.preventDefault();
        await this.applyConfirmation();
      }
      return;
    }
    if (this.mode === 'palette') {
      if (key.name === 'escape') {
        key.preventDefault();
        this.closePalette();
      } else if (key.name === 'up') {
        key.preventDefault();
        this.paletteList.moveUp();
      } else if (key.name === 'down') {
        key.preventDefault();
        this.paletteList.moveDown();
      }
      return;
    }
    if (this.mode === 'targets') {
      if (key.name === 'escape') {
        key.preventDefault();
        this.closeTargetPicker();
      } else if (key.name === 'space') {
        key.preventDefault();
        this.toggleTargetChoice();
      } else if (key.name === 'return' || key.name === 'enter') {
        key.preventDefault();
        await this.applyTargetPicker();
      }
      return;
    }
    if (this.mode === 'help') {
      if (key.name === 'escape' || key.name === '?' || key.name === 'return' || key.name === 'enter') {
        key.preventDefault();
        this.closeHelp();
      }
      return;
    }
    if (this.busy) return;

    const page = TUI_PAGES.find((candidate) => candidate.key === key.name);
    if (page) {
      key.preventDefault();
      this.setPage(page.id);
      return;
    }
    if (key.ctrl && key.name === 'p') {
      key.preventDefault();
      this.openPalette();
      return;
    }
    if (key.name === '?') {
      key.preventDefault();
      this.openHelp();
      return;
    }
    if (key.name === '/' && this.page === 'skills') {
      key.preventDefault();
      this.openSearch();
      return;
    }
    if (key.name === 'e') {
      key.preventDefault();
      await this.beginEdit();
      return;
    }
    if (key.name === 's') {
      key.preventDefault();
      await this.runAction('sync');
      return;
    }
    if (key.name === 'r') {
      key.preventDefault();
      await this.runAction('refresh');
      return;
    }
    if (key.name === 'space' && this.page === 'targets') {
      key.preventDefault();
      await this.toggleCurrentTargetAutoAdopt();
      return;
    }
    if ((key.name === 'return' || key.name === 'enter') && this.page === 'settings') {
      key.preventDefault();
      await this.runSelectedSetting();
      return;
    }
    if (key.name === 'j') {
      key.preventDefault();
      this.list.moveDown();
    } else if (key.name === 'k') {
      key.preventDefault();
      this.list.moveUp();
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
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    clearOnShutdown: true,
    backgroundColor: COLORS.bg,
    targetFps: 30,
    maxFps: 60,
    useMouse: true,
    enableMouseMovement: false,
    openConsoleOnError: false,
  });
  return new Promise((resolve, reject) => {
    const app = new SkillSyncTui({ config, renderer, onExit: resolve });
    app.start().catch((error) => {
      renderer.destroy();
      reject(error);
    });
  });
}
