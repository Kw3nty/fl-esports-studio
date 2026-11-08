#!/usr/bin/env python3
"""Собирает FL Esports Studio в один HTML-файл: dist/FLEsportsStudio.html"""
import pathlib
root = pathlib.Path(__file__).parent
src = root / 'src'
js = '\n'.join((src / f).read_text(encoding='utf-8') for f in ['three.min.js', 'pp.js', 'defaults.js', 'core.js', 'keys.js', 'legend.js', 'icons.js', 'effects.js', 'colorpicker.js', 'sim.js', 'kb3d.js', 'app.js'])
html = (src / 'index.html').read_text(encoding='utf-8')
html = html.replace('/*@@CSS@@*/', (src / 'style.css').read_text(encoding='utf-8'))
html = html.replace('/*@@JS@@*/', js.replace('</script>', '<\\/script>'))
out = root / 'dist'
out.mkdir(exist_ok=True)
(out / 'FLEsportsStudio.html').write_text(html, encoding='utf-8')
print('OK', len(html), 'bytes')
