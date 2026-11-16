// Guards the GitHub Pages mirror: docs/ is what gets published from main, so it
// must be byte-identical to public/. Fix drift with `sh scripts/sync_docs.sh`.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'public');
const MIRROR = path.join(ROOT, 'docs');

function walk(dir, base, out) {
  base = base || dir;
  out = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

let pass = 0;
const pending = [];
const ok = (name, fn) => { pending.push({ name, fn }); };

ok('docs/ holds exactly the files in public/ — nothing extra, nothing missing', () => {
  const source = walk(SOURCE);
  const mirror = walk(MIRROR);
  const missing = source.filter((f) => !mirror.includes(f));
  const extra = mirror.filter((f) => !source.includes(f));
  assert.deepStrictEqual(
    { missing, extra },
    { missing: [], extra: [] },
    'mirror drifted — missing [' + missing.join(', ') + '], extra [' + extra.join(', ') +
      '] — run `sh scripts/sync_docs.sh`'
  );
});

ok('every mirrored file is byte-identical to its public/ source', () => {
  const drifted = walk(SOURCE).filter((f) => {
    const source = path.join(SOURCE, f);
    const mirror = path.join(MIRROR, f);
    return fs.existsSync(mirror) && !fs.readFileSync(source).equals(fs.readFileSync(mirror));
  });
  assert.strictEqual(
    drifted.length,
    0,
    'drifted from public/: ' + drifted.join(', ') + ' — run `sh scripts/sync_docs.sh`'
  );
});

try {
  for (const t of pending) {
    t.fn();
    pass += 1;
    console.log('  ✓', t.name);
  }
  console.log(`\n${pass} checks passed`);
} catch (e) {
  console.error('\n✗ FAILED:', e.message);
  process.exit(1);
}
