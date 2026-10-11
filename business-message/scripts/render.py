#!/usr/bin/env python3
"""Approved message.md -> standalone HTML; only visual placeholders require an LLM asset."""
import argparse
import base64
import html
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

import yaml
from markdown_it import MarkdownIt

TYPES = {'主張', '提案', '相談', '質問', '依頼', '報告', '通知', '注意喚起'}
SECTIONS = ('メッセージ', '背景情報', '作成者向け情報')
ID = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9-]*$')
STYLES = '''body{font-family:system-ui,-apple-system,"Noto Sans JP",sans-serif;line-height:1.75;color:#20242b;max-width:840px;margin:0 auto;padding:clamp(18px,5vw,48px);background:#fff}h1{line-height:1.35}h2{margin-top:1.7em}header{margin-bottom:2rem}.kind{color:#586575;font-size:.85rem}main{font-size:1rem}details{margin-top:2rem;border-top:1px solid #d4d9dd;padding-top:1rem}summary{cursor:pointer;font-weight:600}table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}th,td{border:1px solid #d4d9dd;padding:.5rem .75rem;text-align:left}pre{overflow-x:auto}img,svg{max-width:100%;height:auto}.diagram{margin:1.5rem 0;overflow-x:auto}.pending{padding:1rem;border:2px dashed #a3a3a3}a{overflow-wrap:anywhere}'''


def parse_document(source):
    m = re.match(r'\A---\s*\n(.*?)\n---\s*\n', source, re.S)
    if not m:
        raise ValueError('YAML front matter is required')
    meta = yaml.safe_load(m.group(1))
    if not isinstance(meta, dict) or not isinstance(meta.get('type'), str) or meta['type'] not in TYPES or not isinstance(meta.get('title'), str) or not meta['title'].strip():
        raise ValueError('type must be one category and title must be nonempty')
    body = source[m.end():]
    sections = {}
    current = None
    # Use Markdown's parser so headings inside fenced code cannot change visibility.
    lines = body.splitlines(keepends=True)
    tokens = MarkdownIt('commonmark').parse(body)
    headings = {}
    for index, token in enumerate(tokens):
        if token.type == 'heading_open' and token.tag == 'h1' and token.level == 0:
            headings[token.map[0]] = (tokens[index + 1].content.strip(), token.map[1])
    skip_until = 0
    for index, line in enumerate(lines):
        if index < skip_until:
            continue
        if index in headings:
            current, skip_until = headings[index]
            if current not in SECTIONS or current in sections:
                raise ValueError('Unexpected or repeated top-level section: ' + current)
            sections[current] = ''
        elif current is None:
            if line.strip():
                raise ValueError('Content before the first section')
        else:
            sections[current] += line
    if set(sections) != set(SECTIONS):
        raise ValueError('Exactly three required sections must be present')
    if tuple(sections) != SECTIONS:
        raise ValueError('Sections must be ordered: message, background, author-only')
    if not sections['メッセージ'].strip():
        raise ValueError('Message cannot be empty')
    private_tokens = MarkdownIt('commonmark').parse(sections['作成者向け情報'])
    private_headings = {
        private_tokens[index + 1].content
        for index, token in enumerate(private_tokens)
        if token.type == 'heading_open' and token.tag == 'h2' and token.level == 0
    }
    if not {'実現したい状況', '重要な検討結果'} <= private_headings:
        raise ValueError('Author-only goal and review are required')
    return meta, sections


def parse_visual(value):
    data = yaml.safe_load(value)
    if not isinstance(data, dict) or not ID.fullmatch(str(data.get('id', ''))) or data.get('type') not in {'diagram', 'illustration', 'image'} or not isinstance(data.get('instruction'), str) or not data['instruction'].strip():
        raise ValueError('Invalid visual fence; required: id, type, instruction')
    return data


def safe_svg(svg):
    # SVG is embedded only after strict markup validation; no links, scripts, external resources, CSS, filters or foreign content.
    import xml.etree.ElementTree as ET
    root = ET.fromstring(svg)
    allowed = {'svg','g','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','defs','marker','title','desc'}
    attrs = {'xmlns','viewBox','width','height','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','d','points','transform','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','opacity','font-size','font-family','font-weight','text-anchor','dominant-baseline','markerWidth','markerHeight','refX','refY','orient','marker-end','id'}
    if root.tag.rsplit('}', 1)[-1] != 'svg':
        raise ValueError('SVG root must be svg')
    for node in root.iter():
        if node.tag.rsplit('}',1)[-1] not in allowed or node.tag.startswith('{') and not node.tag.startswith('{http://www.w3.org/2000/svg}'):
            raise ValueError('Disallowed SVG element')
        for name, value in node.attrib.items():
            if name not in attrs or 'url(' in value.lower() or 'javascript:' in value.lower() or 'data:' in value.lower():
                raise ValueError('Disallowed SVG attribute')
    return svg


def render_md(raw, parent, final, ids):
    md = MarkdownIt('commonmark', {'html': False, 'linkify': False}).enable('table')
    default_fence = md.renderer.rules['fence']
    def fence(renderer, tokens, idx, options, env):
        token = tokens[idx]
        language = token.info.strip().split(' ')[0]
        if language == 'visual':
            v = parse_visual(token.content)
            uid = v['id']
            if uid in ids:
                raise ValueError('Duplicate visual id: ' + uid)
            ids.add(uid)
            mark = '<div class="pending" data-visual-id="%s" data-visual-type="%s">図表生成待ち: %s</div>' % (uid, v['type'], html.escape(v['instruction']))
            if not final:
                return mark
            paths = [parent / 'assets' / f'{uid}.{ext}' for ext in ('svg','png','jpg','webp')]
            matches = [p for p in paths if p.is_file()]
            if len(matches) != 1:
                raise ValueError('Exactly one asset required for ' + uid)
            return '<figure class="diagram">' + inline_asset(matches[0], uid) + '</figure>'
        if language == 'mermaid':
            cli = shutil.which('mmdc')
            if not cli:
                raise RuntimeError('mmdc (Mermaid CLI) is required for mermaid fences')
            with tempfile.TemporaryDirectory() as tmp:
                inp = Path(tmp)/'diagram.mmd'
                out = Path(tmp)/'diagram.svg'
                inp.write_text(token.content, encoding='utf-8')
                subprocess.run([cli,'-i',str(inp),'-o',str(out),'-b','transparent'], check=True, capture_output=True, timeout=45)
                # SVG from Mermaid can contain CSS/foreignObject; embed as inert image, not inline active SVG.
                data = base64.b64encode(out.read_bytes()).decode('ascii')
                return '<figure class="diagram"><img alt="処理・関係図" src="data:image/svg+xml;base64,%s"></figure>' % data
        return default_fence(tokens, idx, options, env)
    md.add_render_rule('fence', fence)
    def image(renderer, tokens, idx, options, env):
        token = tokens[idx]
        address = urlsplit(token.attrGet('src'))
        if address.scheme or address.netloc or address.query or address.fragment:
            raise ValueError('Images must be local files under the Markdown directory')
        path = (parent / unquote(address.path)).resolve()
        if not path.is_relative_to(parent.resolve()) or not path.is_file():
            raise ValueError('Image is missing or outside the Markdown directory')
        label = html.escape(token.content, quote=True)
        return inline_asset(path, label, escaped=True)
    md.add_render_rule('image', image)
    return md.render(raw)


def inline_asset(path, uid, escaped=False):
    if path.suffix not in {'.svg', '.png', '.jpg', '.webp'}:
        raise ValueError('Unsupported image format: ' + path.suffix)
    if path.suffix == '.svg':
        safe_svg(path.read_text(encoding='utf-8'))
    mime = {'.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'}[path.suffix]
    payload = base64.b64encode(path.read_bytes()).decode('ascii')
    # Keep ordinary Markdown images inline, including images inside paragraphs.
    return '<img alt="%s" src="data:%s;base64,%s">' % (uid if escaped else html.escape(uid,quote=True),mime,payload)


def render(src, final=False):
    src = Path(src)
    meta, sections = parse_document(src.read_text(encoding='utf-8'))
    ids=set()
    message=render_md(sections['メッセージ'],src.parent,final,ids)
    background=render_md(sections['背景情報'],src.parent,final,ids)
    title=html.escape(meta['title'])
    kind=html.escape(meta['type'])
    doc=f'''<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>{STYLES}</style></head><body><header><div class="kind">{kind}</div><h1>{title}</h1></header><main>{message}</main>{'<details><summary>詳しい背景・根拠</summary>'+background+'</details>' if background.strip() else ''}</body></html>'''
    if final and 'data-visual-id=' in doc:
        raise ValueError('Unresolved visual marks')
    path=src.with_suffix('.html')
    path.write_text(doc,encoding='utf-8')
    return path


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('markdown')
    stage=parser.add_mutually_exclusive_group(required=True)
    stage.add_argument('--stage',action='store_true')
    stage.add_argument('--final',action='store_true')
    args=parser.parse_args()
    print(render(args.markdown,final=args.final))
