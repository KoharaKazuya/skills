import sys
import subprocess
import shutil
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from render import parse_document, render, safe_svg

DOC = '''---
type: 提案
title: 表示タイトル
---
# メッセージ

公開本文。

| A | B |
|---|---|
| 1 | 2 |

```visual
id: example-chart
type: diagram
instruction: |
  承認済みの図。
```

# 背景情報

公開背景。

# 作成者向け情報

## 実現したい状況

秘密のゴール。

## 重要な検討結果

非公開の検討結果。
'''

class RenderTests(unittest.TestCase):
    def test_cli_stage_and_final_with_bundled_example(self):
        skill = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'example'
            shutil.copytree(skill / 'examples', root)
            source = root / 'message.md'
            for option in ('--stage', '--final'):
                result = subprocess.run(
                    [sys.executable, str(skill / 'scripts' / 'render.py'), str(source), option],
                    check=True, capture_output=True, text=True,
                )
                self.assertEqual(result.stdout.strip(), str(source.with_suffix('.html')))
                output = source.with_suffix('.html').read_text(encoding='utf-8')
                self.assertIn('新しい設計方法を試すことを提案', output)
                self.assertNotIn('関係者が試験導入の可否を判断できる', output)
                self.assertEqual('data-visual-id=' in output, option == '--stage')
                if option == '--final':
                    self.assertIn('data:image/svg+xml;base64,', output)

    def render_doc(self, document, final=False):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'message.md'
            path.write_text(document, encoding='utf-8')
            return render(path, final=final).read_text(encoding='utf-8')

    def test_fenced_private_heading_does_not_publish_secrets(self):
        doc = DOC.replace('秘密のゴール。', '秘密のゴール。\n\n~~~text\n# メッセージ\n~~~\n漏れてはいけない情報。')
        output = self.render_doc(doc)
        self.assertNotIn('漏れてはいけない情報', output)
        self.assertNotIn('秘密のゴール', output)

    def test_fenced_public_heading_is_literal_code(self):
        doc = DOC.replace('公開本文。', '公開本文。\n\n\x60\x60\x60text\n# メッセージ\n\x60\x60\x60')
        self.assertIn('# メッセージ', self.render_doc(doc))

    def test_sections_must_follow_the_document_contract(self):
        doc = DOC.replace('# メッセージ', '# TEMP').replace('# 背景情報', '# メッセージ').replace('# TEMP', '# 背景情報')
        with self.assertRaises(ValueError):
            parse_document(doc)

    def test_private_required_headings_cannot_be_faked_in_code(self):
        doc = DOC.replace('## 実現したい状況', '~~~text\n## 実現したい状況\n~~~')
        with self.assertRaises(ValueError):
            parse_document(doc)

    def test_non_string_classification_is_rejected(self):
        for value in ('[提案, 報告]', '{a: b}', 'null'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_document(DOC.replace('type: 提案', 'type: ' + value))

    def test_raw_html_and_title_are_escaped(self):
        output = self.render_doc(DOC.replace('表示タイトル', '<script>title</script>').replace('公開本文。', '<script>alert(1)</script>'))
        self.assertNotIn('<script>', output)
        self.assertIn('&lt;script&gt;', output)

    def test_local_markdown_image_is_embedded(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'image.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg"/>', encoding='utf-8')
            path = root / 'message.md'
            path.write_text(DOC.replace('公開本文。', '公開本文。 ![説明](image.svg)'), encoding='utf-8')
            output = render(path).read_text(encoding='utf-8')
            self.assertIn('alt="説明" src="data:image/svg+xml;base64,', output)
            self.assertNotIn('src="image.svg"', output)
            self.assertNotIn('<p><figure', output)

    def test_remote_missing_and_outside_images_fail(self):
        for source in ('https://example.com/a.png', '../outside.png', 'missing.png', '//example.com/a.png'):
            with self.subTest(source=source), self.assertRaises(ValueError):
                self.render_doc(DOC.replace('公開本文。', '![説明](' + source + ')'))

    def test_multiple_assets_fail_without_overwriting_html(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / 'message.md'
            path.write_text(DOC, encoding='utf-8')
            before = render(path).read_bytes()
            (root / 'assets').mkdir()
            for suffix in ('svg', 'png'):
                (root / 'assets' / ('example-chart.' + suffix)).write_text('<svg/>', encoding='utf-8')
            with self.assertRaises(ValueError):
                render(path, final=True)
            self.assertEqual(before, path.with_suffix('.html').read_bytes())

    def test_mermaid_requires_cli(self):
        doc = DOC.replace('公開本文。', '~~~mermaid\nflowchart TD\n A --> B\n~~~')
        with patch('render.shutil.which', return_value=None), self.assertRaisesRegex(RuntimeError, 'mmdc'):
            self.render_doc(doc)

    def test_mermaid_cli_output_is_embedded(self):
        doc = DOC.replace('公開本文。', '~~~mermaid\nflowchart TD\n A --> B\n~~~')
        def cli(arguments, **options):
            self.assertEqual(arguments[0], '/test/mmdc')
            self.assertTrue(options['check'])
            Path(arguments[arguments.index('-o') + 1]).write_text('<svg xmlns="http://www.w3.org/2000/svg"/>', encoding='utf-8')
        with patch('render.shutil.which', return_value='/test/mmdc'), patch('render.subprocess.run', side_effect=cli):
            self.assertIn('data:image/svg+xml;base64,', self.render_doc(doc))

    def test_stage_and_final_exclude_private(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            md = root/'message.md'; md.write_text(DOC,encoding='utf-8')
            stage = render(md).read_text(encoding='utf-8')
            self.assertIn('data-visual-id="example-chart"',stage)
            self.assertIn('<table>',stage)
            self.assertNotIn('秘密のゴール',stage)
            self.assertNotIn('非公開の検討結果',stage)
            with self.assertRaises(ValueError): render(md,final=True)
            (root/'assets').mkdir()
            (root/'assets'/'example-chart.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10" fill="red"/></svg>',encoding='utf-8')
            result = render(md,final=True).read_text(encoding='utf-8')
            self.assertIn('data:image/svg+xml;base64,',result)
            self.assertNotIn('data-visual-id=',result)
            self.assertIn('公開本文',result)
            self.assertNotIn('秘密のゴール',result)
            self.assertEqual(result,render(md,final=True).read_text(encoding='utf-8'))
    def test_bad_svg(self):
        with self.assertRaises(ValueError): safe_svg('<svg><script>alert(1)</script></svg>')
        with self.assertRaises(ValueError): safe_svg('<svg onload="alert(1)"/>')
        with self.assertRaises(ValueError): safe_svg('<svg><image href="https://example.com/a"/></svg>')
    def test_bad_classification(self):
        with self.assertRaises(ValueError): parse_document(DOC.replace('type: 提案','type: 複数'))
    def test_duplicate_visual_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'message.md'
            path.write_text(DOC.replace('# 背景情報','```visual\nid: example-chart\ntype: image\ninstruction: 重複\n```\n# 背景情報'),encoding='utf-8')
            with self.assertRaises(ValueError): render(path)

if __name__ == '__main__': unittest.main()
