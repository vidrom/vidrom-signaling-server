const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const portalsDir = path.join(__dirname, '..', 'portals');

function readPortal(fileName) {
  return fs.readFileSync(path.join(portalsDir, fileName), 'utf8');
}

test('portal HTML pages avoid inline script blocks and inline event handlers', () => {
  for (const fileName of ['admin.html', 'management.html']) {
    const html = readPortal(fileName);
    assert.doesNotMatch(html, /<script>([\s\S]*?)<\/script>/i, `${fileName} should not contain inline script blocks`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${fileName} should not contain inline DOM event handlers`);
    assert.match(html, /Content-Security-Policy/i, `${fileName} should declare a page CSP`);
  }
});

test('portal HTML pages load external page scripts', () => {
  const adminHtml = readPortal('admin.html');
  const managementHtml = readPortal('management.html');
  assert.match(adminHtml, /<script src="\/admin\.js" defer><\/script>/i);
  assert.match(managementHtml, /<script src="\/management\.js" defer><\/script>/i);
});