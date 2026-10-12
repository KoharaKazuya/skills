import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseDocument, render, safeSvg } from '../scripts/render.js';
const skill = fileURLToPath(new URL('../', import.meta.url));
const DOC = `---
type: 提案
title: 表示タイトル
---
# メッセージ

公開本文。

| A | B |
|---|---|
| 1 | 2 |

\`\`\`visual
id: example-chart
type: diagram
instruction: |
  承認済みの図。
\`\`\`

# 背景情報

公開背景。

# 作成者向け情報

## 実現したい状況

秘密のゴール。

## 重要な検討結果

非公開の検討結果。
`;
function temp(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message tests 日本語 '));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function output(doc = DOC, options = {}) {
  return temp(root => {
    const src = path.join(root, 'message.md');
    fs.writeFileSync(src, doc);
    return fs.readFileSync(render(src, options), 'utf8');
  });
}
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>';
test('final HTML can be shared alone without source files or external resources', () => temp(root => {
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(source, 'assets/example-chart.svg'), svg);
  fs.writeFileSync(path.join(source, 'image.svg'), svg);
  const src = path.join(source, 'message.md');
  fs.writeFileSync(src, DOC.replace('公開本文。', '公開本文。 ![添付図](image.svg) [出典](https://example.com/reference)'));
  const shared = path.join(root, 'shared.html');
  fs.copyFileSync(render(src, { final: true }), shared);
  fs.rmSync(source, { recursive: true });
  const html = fs.readFileSync(shared, 'utf8');
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<style>'));
  assert.ok(html.includes('http-equiv="Content-Security-Policy"'));
  assert.ok(html.includes("default-src &#x27;none&#x27;; img-src data:; style-src &#x27;unsafe-inline&#x27;"));
  assert.ok(html.includes('<details><summary>詳しい背景・根拠</summary>'));
  assert.ok(html.includes('公開本文。'));
  assert.ok(html.includes('公開背景。'));
  assert.ok(html.includes('href="https://example.com/reference"'));
  const images = [...html.matchAll(/<img\b[^>]*src="([^"]+)"/g)];
  assert.equal(images.length, 2);
  for (const [, address] of images) {
    assert.ok(address.startsWith('data:image/svg+xml;base64,'));
    assert.equal(Buffer.from(address.split(',')[1], 'base64').toString('utf8'), svg);
  }
  assert.doesNotMatch(html, /<script\b|<link\b|data-visual-id=|秘密のゴール|非公開の検討結果/);
}));
test('CLI stage/final renders bundled example from another working directory', () => temp(root => {
  fs.cpSync(path.join(skill, 'examples'), root, { recursive: true });
  const src = path.join(root, 'message.md');
  for (const option of ['--stage', '--final']) {
    const result = spawnSync(process.execPath, [path.join(skill, 'scripts/render.js'), src, option], { cwd: os.tmpdir(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), path.join(root, 'message.html'));
    const html = fs.readFileSync(path.join(root, 'message.html'), 'utf8');
    assert.ok(html.includes('新しい設計方法を試すことを提案'));
    assert.ok(!html.includes('関係者が試験導入の可否を判断できる'));
    assert.equal(html.includes('data-visual-id='), option === '--stage');
    if (option === '--final') assert.ok(html.includes('data:image/svg+xml;base64,'));
  }
}));
test('fenced private headings never expose private information', () => {
  const html = output(DOC.replace('秘密のゴール。', '秘密のゴール。\n~~~text\n# メッセージ\n~~~\n漏れてはいけない情報。'));
  assert.ok(!html.includes('漏れてはいけない情報'));
  assert.ok(!html.includes('秘密のゴール'));
});
test('public heading inside code stays literal', () => assert.ok(output(DOC.replace('公開本文。', '~~~text\n# メッセージ\n~~~')).includes('# メッセージ')));
test('section order is required', () => assert.throws(() => parseDocument(DOC.replace('# メッセージ', '# TEMP').replace('# 背景情報', '# メッセージ').replace('# TEMP', '# 背景情報'))));
test('private required headings cannot be faked in code', () => assert.throws(() => parseDocument(DOC.replace('## 実現したい状況', '~~~text\n## 実現したい状況\n~~~'))));
test('invalid classifications and title types are rejected', () => {
  for (const value of ['[提案, 報告]', '{a: b}', 'null', '複数']) assert.throws(() => parseDocument(DOC.replace('type: 提案', 'type: ' + value)));
  for (const value of ['null', '123', '[]', '""']) assert.throws(() => parseDocument(DOC.replace('title: 表示タイトル', 'title: ' + value)));
});
test('raw HTML and title are escaped', () => {
  const html = output(DOC.replace('表示タイトル', '<script>title</script>').replace('公開本文。', '<script>alert(1)</script>'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
test('local image is embedded inline with escaped alt', () => temp(root => {
  fs.writeFileSync(path.join(root, '図 image.svg'), svg);
  const src = path.join(root, 'message.md');
  fs.writeFileSync(src, DOC.replace('公開本文。', '公開本文。 ![説明 "quoted"](%E5%9B%B3%20image.svg)'));
  const html = fs.readFileSync(render(src), 'utf8');
  assert.ok(html.includes('alt="説明 &quot;quoted&quot;" src="data:image/svg+xml;base64,'));
  assert.ok(!html.includes('<p><figure'));
}));
test('remote, missing, outside and unsupported images fail', () => {
  for (const address of ['https://example.com/a.png', '../outside.png', 'missing.png', '//example.com/a.png', '%2Ftmp/a.svg', 'C:%5Cimage.png', 'a.svg?x=1', 'a.svg#x']) {
    assert.throws(() => output(DOC.replace('公開本文。', `![説明](${address})`)));
  }
  temp(root => {
    fs.writeFileSync(path.join(root, 'image.gif'), 'gif');
    const src = path.join(root, 'message.md');
    fs.writeFileSync(src, DOC.replace('公開本文。', '![説明](image.gif)'));
    assert.throws(() => render(src), /Unsupported/);
  });
});
test('unsafe file URL is rendered as literal text, never an image', () => {
  assert.ok(output(DOC.replace('公開本文。', '![説明](file:///tmp/a.svg)')).includes('![説明](file:///tmp/a.svg)'));
});
test('duplicate assets fail without overwriting existing HTML', () => temp(root => {
  const src = path.join(root, 'message.md');
  fs.writeFileSync(src, DOC);
  const html = render(src), before = fs.readFileSync(html);
  fs.mkdirSync(path.join(root, 'assets'));
  for (const ext of ['svg', 'png']) fs.writeFileSync(path.join(root, 'assets/example-chart.' + ext), svg);
  assert.throws(() => render(src, { final: true }));
  assert.deepEqual(fs.readFileSync(html), before);
}));
test('Mermaid missing CLI produces actionable failure', t => {
  if (fs.existsSync(path.join(skill, 'node_modules/@mermaid-js/mermaid-cli/package.json'))) {
    t.skip('Optional local Mermaid CLI is installed');
    return;
  }
  const original = process.env.PATH;
  process.env.PATH = '';
  try { assert.throws(() => output(DOC.replace('公開本文。', '~~~mermaid\nflowchart TD\n A --> B\n~~~')), /mmdc/); }
  finally { process.env.PATH = original; }
});
test('Mermaid subprocess receives source, embeds output and propagates errors', () => temp(root => {
  const cli = path.join(root, 'fake cli.cjs');
  fs.writeFileSync(cli, `const fs=require('node:fs');const a=process.argv; if(!fs.readFileSync(a[a.indexOf('-i')+1],'utf8').includes('A --> B')) process.exit(2);fs.writeFileSync(a[a.indexOf('-o')+1],'<svg xmlns="http://www.w3.org/2000/svg"/>');`);
  const doc = DOC.replace('公開本文。', '~~~mermaid\nflowchart TD\n A --> B\n~~~');
  assert.ok(output(doc, { mermaidCommand: [process.execPath, cli] }).includes('data:image/svg+xml;base64,'));
  fs.writeFileSync(cli, 'process.exit(7)');
  assert.throws(() => output(doc, { mermaidCommand: [process.execPath, cli] }), /Mermaid CLI failed/);
}));
test('stage/final keep public content and exclude private; final is repeatable', () => temp(root => {
  const src = path.join(root, 'message.md');
  fs.writeFileSync(src, DOC);
  const stage = fs.readFileSync(render(src), 'utf8');
  assert.ok(stage.includes('data-visual-id="example-chart"'));
  assert.ok(stage.includes('<table>'));
  assert.ok(!stage.includes('秘密のゴール'));
  assert.throws(() => render(src, { final: true }));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets/example-chart.svg'), svg);
  const final = fs.readFileSync(render(src, { final: true }), 'utf8');
  assert.ok(final.includes('公開本文'));
  assert.ok(final.includes('data:image/svg+xml;base64,'));
  for (const secret of ['data-visual-id=', '秘密のゴール', '非公開の検討結果']) assert.ok(!final.includes(secret));
  assert.equal(final, fs.readFileSync(render(src, { final: true }), 'utf8'));
}));
test('unsafe and malformed SVG is rejected', () => {
  for (const input of ['<svg><script>alert(1)</script></svg>', '<svg onload="alert(1)"/>', '<svg><image href="https://example.com/a"/></svg>', '<svg><rect></svg>', '<svg/><svg/>', '<!DOCTYPE svg [<!ENTITY x "a">]><svg/>', '<svg xmlns="https://evil.example"/>', '<svg><rect fill="url(#x)"/></svg>']) assert.throws(() => safeSvg(input), input);
  assert.equal(safeSvg(svg), svg);
});
test('visual ids are unique across sections', () => assert.throws(() => output(DOC.replace('公開背景。', '~~~visual\nid: example-chart\ntype: image\ninstruction: 重複\n~~~')), /Duplicate/));
test('CRLF source behaves identically', () => assert.equal(output(DOC.replace(/\n/g, '\r\n')), output(DOC)));
test('CLI rejects missing/conflicting mode and reports render errors', () => temp(root => {
  for (const args of [[], ['missing.md'], ['missing.md', '--stage', '--final'], ['missing.md', '--final']]) {
    const result = spawnSync(process.execPath, [path.join(skill, 'scripts/render.js'), ...args], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.trim());
  }
}));
test('symlink escape is rejected for Markdown images and visual assets', t => temp(root => {
  const outside = path.join(root, 'outside.svg'), parent = path.join(root, 'document');
  fs.writeFileSync(outside, svg);
  fs.mkdirSync(parent);
  fs.mkdirSync(path.join(parent, 'assets'));
  try { fs.symlinkSync(outside, path.join(parent, 'assets/example-chart.svg'), 'file'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Symlinks require OS permission'); return; } throw error; }
  const src = path.join(parent, 'message.md');
  fs.writeFileSync(src, DOC);
  assert.throws(() => render(src, { final: true }), /outside/);
  fs.writeFileSync(src, DOC.replace('公開本文。', '![説明](assets/example-chart.svg)'));
  assert.throws(() => render(src), /outside/);
}));
