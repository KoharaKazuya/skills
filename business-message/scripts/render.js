#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { parse as parseYaml } from 'yaml';
import { DOMParser } from '@xmldom/xmldom';

const TYPES = new Set(['主張', '提案', '相談', '質問', '依頼', '報告', '通知', '注意喚起']);
const SECTIONS = ['メッセージ', '背景情報', '作成者向け情報'];
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[c]);
const yaml = source => parseYaml(source, { maxAliasCount: 50, uniqueKeys: true });
const STYLES = "body{font-family:system-ui,-apple-system,\"Noto Sans JP\",sans-serif;line-height:1.75;color:#20242b;max-width:840px;margin:0 auto;padding:clamp(18px,5vw,48px);background:#fff}h1{line-height:1.35}h2{margin-top:1.7em}header{margin-bottom:2rem}.kind{color:#586575;font-size:.85rem}main{font-size:1rem}details{margin-top:2rem;border-top:1px solid #d4d9dd;padding-top:1rem}summary{cursor:pointer;font-weight:600}table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}th,td{border:1px solid #d4d9dd;padding:.5rem .75rem;text-align:left}pre{overflow-x:auto}img,svg{max-width:100%;height:auto}.diagram{margin:1.5rem 0;overflow-x:auto}.pending{padding:1rem;border:2px dashed #a3a3a3}a{overflow-wrap:anywhere}";

export function parseDocument(source) {
  source = source.replace(/\r\n?/g, '\n');
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(source);
  if (!match) throw new Error('YAML front matter is required');
  const meta = yaml(match[1]);
  if (!meta || typeof meta !== 'object' || !TYPES.has(meta.type) || typeof meta.title !== 'string' || !meta.title.trim()) throw new Error('type must be one category and title must be nonempty');
  const body = source.slice(match[0].length);
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) || [];
  const headings = new Map();
  const tokens = new MarkdownIt('commonmark').parse(body, {});
  tokens.forEach((t, i) => {
    if (t.type === 'heading_open' && t.tag === 'h1' && t.level === 0) headings.set(t.map[0], [tokens[i + 1].content.trim(), t.map[1]]);
  });
  const sections = new Map();
  let current, skipUntil = 0;
  lines.forEach((line, i) => {
    if (i < skipUntil) return;
    if (headings.has(i)) {
      [current, skipUntil] = headings.get(i);
      if (!SECTIONS.includes(current) || sections.has(current)) throw new Error('Unexpected or repeated top-level section: ' + current);
      sections.set(current, '');
    } else if (current === undefined) {
      if (line.trim()) throw new Error('Content before the first section');
    } else sections.set(current, sections.get(current) + line);
  });
  if (JSON.stringify([...sections.keys()]) !== JSON.stringify(SECTIONS)) throw new Error('Exactly three required sections must be ordered');
  if (!sections.get(SECTIONS[0]).trim()) throw new Error('Message cannot be empty');
  const privateTokens = new MarkdownIt('commonmark').parse(sections.get(SECTIONS[2]), {});
  const privateHeadings = new Set();
  privateTokens.forEach((t, i) => {
    if (t.type === 'heading_open' && t.tag === 'h2' && t.level === 0) privateHeadings.add(privateTokens[i + 1].content);
  });
  if (!['実現したい状況', '重要な検討結果'].every(h => privateHeadings.has(h))) throw new Error('Author-only goal and review are required');
  return { meta, sections };
}

export function safeSvg(svg) {
  if (/<!DOCTYPE|<!ENTITY|<\?/i.test(svg)) throw new Error('Disallowed SVG declaration');
  const errors = [];
  const doc = new DOMParser({ errorHandler: { warning: e => errors.push(e), error: e => errors.push(e), fatalError: e => errors.push(e) } }).parseFromString(svg, 'image/svg+xml');
  if (errors.length || !doc.documentElement || doc.documentElement.localName !== 'svg') throw new Error('Invalid SVG');
  const elements = new Set('svg g path rect circle ellipse line polyline polygon text tspan defs marker title desc'.split(' '));
  const attrs = new Set('xmlns viewBox width height x y x1 x2 y1 y2 cx cy r rx ry d points transform fill stroke stroke-width stroke-linecap stroke-linejoin opacity font-size font-family font-weight text-anchor dominant-baseline markerWidth markerHeight refX refY orient marker-end id'.split(' '));
  function visit(node) {
    if (node.nodeType === 1) {
      if (!elements.has(node.localName) || (node.namespaceURI && node.namespaceURI !== 'http://www.w3.org/2000/svg')) throw new Error('Disallowed SVG element');
      for (let i = 0; i < node.attributes.length; i++) {
        const a = node.attributes.item(i);
        if (!attrs.has(a.name) || /url\s*\(|javascript:|data:/i.test(a.value)) throw new Error('Disallowed SVG attribute');
      }
    } else if (![3, 8, 9].includes(node.nodeType)) throw new Error('Disallowed SVG node');
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  }
  visit(doc);
  return svg;
}

const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
function within(parent, filename) {
  const root = fs.realpathSync(parent), resolved = fs.realpathSync(filename);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !fs.statSync(resolved).isFile()) throw new Error('Image is missing or outside the Markdown directory');
  return resolved;
}
function inlineAsset(filename, label) {
  const ext = path.extname(filename);
  if (!MIME[ext]) throw new Error('Unsupported image format: ' + ext);
  const bytes = fs.readFileSync(filename);
  if (ext === '.svg') safeSvg(bytes.toString('utf8'));
  return `<img alt="${escape(label)}" src="data:${MIME[ext]};base64,${bytes.toString('base64')}">`;
}
function mermaidCommand() {
  // Invoke the local package's JS entry point directly, including on Windows.
  const packageFile = new URL('../node_modules/@mermaid-js/mermaid-cli/package.json', import.meta.url);
  if (fs.existsSync(packageFile)) {
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    return [process.execPath, fileURLToPath(new URL(pkg.bin.mmdc, packageFile))];
  }
  if (process.platform !== 'win32') {
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
      const filename = path.join(directory, 'mmdc');
      try { fs.accessSync(filename, fs.constants.X_OK); return [filename]; } catch { /* try next */ }
    }
  }
  throw new Error('mmdc (Mermaid CLI) is required; install it locally in the skill directory');
}
function renderMarkdown(raw, parent, final, ids, options) {
  const md = new MarkdownIt('commonmark', { html: false, linkify: false }).enable('table');
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, index, settings, env, self) => {
    const token = tokens[index], language = token.info.trim().split(/\s+/)[0];
    if (language === 'visual') {
      const v = yaml(token.content);
      if (!v || typeof v.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(v.id) || !['diagram', 'illustration', 'image'].includes(v.type) || typeof v.instruction !== 'string' || !v.instruction.trim()) throw new Error('Invalid visual fence');
      if (ids.has(v.id)) throw new Error('Duplicate visual id: ' + v.id);
      ids.add(v.id);
      if (!final) return `<div class="pending" data-visual-id="${v.id}" data-visual-type="${v.type}">図表生成待ち: ${escape(v.instruction)}</div>`;
      const matches = Object.keys(MIME).map(ext => path.join(parent, 'assets', v.id + ext)).filter(p => fs.existsSync(p) && fs.statSync(p).isFile());
      if (matches.length !== 1) throw new Error('Exactly one asset required for ' + v.id);
      return '<figure class="diagram">' + inlineAsset(within(parent, matches[0]), v.id) + '</figure>';
    }
    if (language === 'mermaid') {
      const command = options.mermaidCommand ?? mermaidCommand();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'business-message-'));
      try {
        const input = path.join(tmp, 'diagram.mmd'), output = path.join(tmp, 'diagram.svg');
        fs.writeFileSync(input, token.content, 'utf8');
        const result = spawnSync(command[0], [...command.slice(1), '-i', input, '-o', output, '-b', 'transparent'], { timeout: 45000, encoding: 'utf8', shell: false, windowsHide: true });
        if (result.error || result.status !== 0) throw new Error('Mermaid CLI failed: ' + (result.error?.message || result.stderr || result.status));
        // Mermaid SVG can contain CSS/foreignObject; embed as inert image, never inline SVG.
        return `<figure class="diagram"><img alt="処理・関係図" src="data:image/svg+xml;base64,${fs.readFileSync(output).toString('base64')}"></figure>`;
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
    return defaultFence(tokens, index, settings, env, self);
  };
  md.renderer.rules.image = (tokens, index) => {
    const token = tokens[index], address = token.attrGet('src');
    if (/^[a-z][a-z\d+.-]*:|^[/\\]|[?#]/i.test(address)) throw new Error('Images must be local files under the Markdown directory');
    const decoded = decodeURIComponent(address);
    if (/^[a-z][a-z\d+.-]*:|^[/\\]/i.test(decoded)) throw new Error('Images must be local files under the Markdown directory');
    return inlineAsset(within(parent, path.resolve(parent, decoded)), token.content);
  };
  return md.render(raw);
}
export function render(source, { final = false, ...options } = {}) {
  const src = path.resolve(source);
  const { meta, sections } = parseDocument(fs.readFileSync(src, 'utf8'));
  const ids = new Set();
  const message = renderMarkdown(sections.get(SECTIONS[0]), path.dirname(src), final, ids, options);
  const background = renderMarkdown(sections.get(SECTIONS[1]), path.dirname(src), final, ids, options);
  const title = escape(meta.title), kind = escape(meta.type);
  const doc = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${STYLES}</style></head><body><header><div class="kind">${kind}</div><h1>${title}</h1></header><main>${message}</main>${background.trim() ? '<details><summary>詳しい背景・根拠</summary>' + background + '</details>' : ''}</body></html>`;
  if (final && doc.includes('data-visual-id=')) throw new Error('Unresolved visual marks');
  const parsed = path.parse(src), output = path.join(parsed.dir, parsed.name + '.html');
  if (output === src) throw new Error('Source must not have an .html extension');
  fs.writeFileSync(output, doc, 'utf8');
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !['--stage', '--final'].includes(args[1])) {
    console.error('Usage: node scripts/render.js path/to/message.md (--stage|--final)');
    process.exitCode = 1;
  } else {
    try { console.log(render(args[0], { final: args[1] === '--final' })); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
