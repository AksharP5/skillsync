import test from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../src/core/git.js';

const text = 'caf\u00e9 \u6c49\u5b57\n';
const splitOutput = String.raw`
  const { setTimeout } = require('node:timers/promises');
  const output = Buffer.from('caf\u00e9 \u6c49\u5b57\n');
  (async () => {
    let start = 0;
    for (const end of [4, 7, 10, output.length]) {
      process.stdout.write(output.subarray(start, end));
      process.stderr.write(output.subarray(start, end));
      start = end;
      await setTimeout(25);
    }
    process.exitCode = Number(process.argv[1]);
  })();
`;

test('run decodes split multibyte stdout and stderr without changing the output', async () => {
  const result = await run(process.execPath, ['-e', splitOutput, '0'], { timeoutMs: 5000 });

  assert.deepEqual(result, { stdout: text, stderr: text, code: 0 });
});

test('run preserves split multibyte stderr in a failed command error', async () => {
  await assert.rejects(
    run(process.execPath, ['-e', splitOutput, '7'], { timeoutMs: 5000 }),
    (error) => {
      assert.match(error.message, /failed \(7\)/);
      assert.ok(error.message.endsWith(text));
      assert.doesNotMatch(error.message, /\uFFFD/);
      return true;
    },
  );
});

test('run retains inherited stdio without captured streams', async () => {
  const result = await run(process.execPath, ['-e', 'process.exit(0)'], { inherit: true, timeoutMs: 5000 });

  assert.deepEqual(result, { stdout: '', stderr: '', code: 0 });
});
