// tsc only emits JavaScript, so non-code assets (test fixtures) need copying
// into dist alongside it. Kept in Node so the build works on every platform.
import fs from 'node:fs';
import path from 'node:path';

const pairs = [['src/testing/fixtures', 'dist/testing/fixtures']];

for (const [from, to] of pairs) {
  if (!fs.existsSync(from)) continue;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from)) {
    fs.copyFileSync(path.join(from, entry), path.join(to, entry));
  }
  console.log(`copied ${from} -> ${to}`);
}
