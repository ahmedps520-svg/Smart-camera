import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with']);
const files = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === 'mediapipe' ? [] : files(p)) : p.endsWith('.js') ? [p] : []; });

// A class method defined twice silently replaces the first one (this hid the
// Find-the-shot box once), so fail loudly instead.
test('no class defines the same method twice', () => {
  const dupes = [];
  for (const f of files(new URL('../js', import.meta.url).pathname)) {
    const src = readFileSync(f, 'utf8');
    for (const cls of src.split(/^(?:export )?class /m).slice(1)) {
      const name = cls.match(/^\w+/)?.[0], seen = new Set();
      for (const m of cls.matchAll(/^ {2}(?:static |async |get |set )?(\w+)\s*\([^)]*\)\s*\{/gm)) {
        if (KEYWORDS.has(m[1])) continue;
        const key = m[0].includes('get ') ? `get ${m[1]}` : m[0].includes('set ') ? `set ${m[1]}` : m[1];
        if (seen.has(key)) dupes.push(`${f.split('/js/')[1]}: ${name}.${key}`);
        seen.add(key);
      }
    }
  }
  assert.deepEqual(dupes, []);
});
