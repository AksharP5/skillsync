import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

function splitPath(pathValue) {
  return String(pathValue || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function findExecutable(command, pathValue = process.env.PATH) {
  for (const directory of splitPath(pathValue)) {
    const candidate = path.join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

export async function daemonInvocation({
  pathValue = process.env.PATH,
  execPath = process.execPath,
  cliPath = path.resolve(process.argv[1]),
} = {}) {
  const stableCli = await findExecutable('skillsync', pathValue);
  if (stableCli) {
    return { command: stableCli, args: ['daemon'] };
  }
  return { command: execPath, args: [cliPath, 'daemon'] };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function servicePath(command, pathValue) {
  return [
    path.dirname(command),
    ...splitPath(pathValue),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter((entry, index, entries) => entries.indexOf(entry) === index).join(path.delimiter);
}

export function renderLaunchAgent({
  label,
  command,
  args = [],
  pathValue = process.env.PATH,
}) {
  const argumentsXml = [command, ...args]
    .map((argument) => `<string>${xmlEscape(argument)}</string>`)
    .join('');
  const environmentPath = servicePath(command, pathValue);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${xmlEscape(label)}</string>\n  <key>ProgramArguments</key><array>${argumentsXml}</array>\n  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xmlEscape(environmentPath)}</string></dict>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n</dict></plist>\n`;
}

function systemdQuote(value) {
  return `"${String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')}"`;
}

export function renderSystemdUserService({
  command,
  args = [],
  pathValue = process.env.PATH,
}) {
  const invocation = [command, ...args].map(systemdQuote).join(' ');
  const environmentPath = servicePath(command, pathValue);
  return `[Unit]\nDescription=SkillSync daemon\n\n[Service]\nType=simple\nEnvironment=${systemdQuote(`PATH=${environmentPath}`)}\nExecStart=${invocation}\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n`;
}
