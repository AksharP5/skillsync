import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { listDevices } from '../src/core/device.js';

for (const populated of [false, true]) {
  test(`listing ${populated ? 'reported-only devices initializes an incomplete vault' : 'an empty vault preserves its minimal layout'}`, async (t) => {
    const vault = await mkdtemp(path.join(tmpdir(), 'skillsync-list-init-'));
    t.after(() => rm(vault, { recursive: true, force: true }));
    if (populated) {
      await mkdir(path.join(vault, 'state'));
      for (const deviceId of ['second', 'first']) {
        await writeFile(path.join(vault, 'state', `${deviceId}.json`), JSON.stringify({
          version: 1, device_id: deviceId, display_name: deviceId, detected: {},
        }));
      }
    }

    const devices = await listDevices(vault);

    assert.deepEqual(devices.map((device) => device.device_id), populated ? ['first', 'second'] : []);
    assert.deepEqual((await readdir(vault)).sort(), populated
      ? ['devices', 'globals', 'registry.json', 'skills', 'state', 'vault.json']
      : ['devices', 'globals', 'state']);
    if (populated) {
      assert.deepEqual(JSON.parse(await readFile(path.join(vault, 'registry.json'), 'utf8')), { version: 1, skills: {} });
    }
  });
}
