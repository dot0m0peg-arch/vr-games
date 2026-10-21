"""Check site structure and local HTML links. No external dependencies."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, unquote
import subprocess

ROOT = Path(__file__).resolve().parents[1]
class Document(HTMLParser):
    def __init__(self):
        super().__init__(); self.links=[]; self.ids=set(); self.h1=0; self.title=False; self.lang=False
    def handle_starttag(self, tag, attrs):
        a=dict(attrs)
        if tag=='html': self.lang=bool(a.get('lang'))
        if tag=='h1': self.h1+=1
        if tag=='title': self.title=True
        if a.get('id'): self.ids.add(a['id'])
        for key in ('href','src'):
            if a.get(key): self.links.append(a[key])

def check():
    required=['index.html','how-to-play.html','404.html','.nojekyll','assets/styles.css',
              'assets/xr-check.js','assets/favicon.svg','games/miner/index.html',
              'games/_template/index.html','README.md','CLAUDE.md','docs/ADDING-GAMES.md','docs/DEPLOYMENT.md']
    for item in required:
        assert (ROOT/item).is_file(), f'Missing {item}'
    docs={}
    for path in ROOT.rglob('*.html'):
        if any(part in {'.git','node_modules'} for part in path.relative_to(ROOT).parts): continue
        doc=Document(); doc.feed(path.read_text(encoding='utf-8')); docs[path.resolve()]=doc
        assert doc.lang and doc.title and doc.h1==1, f'Invalid document metadata: {path}'
        assert 'main' in doc.ids, f'Missing main target: {path}'
    checked=0
    for path,doc in docs.items():
        for link in doc.links:
            parsed=urlsplit(link)
            if parsed.scheme or parsed.netloc: continue
            raw=unquote(parsed.path)
            if raw.startswith('/vr-games/'):
                target=ROOT/raw[len('/vr-games/'):]
            else:
                assert not raw.startswith('/'), f'Outside project prefix: {link}'
                target=path.parent/raw if raw else path
            if target.is_dir(): target=target/'index.html'
            target=target.resolve()
            assert target.is_relative_to(ROOT), f'Escapes repository: {link}'
            assert target.is_file(), f'Broken link in {path.relative_to(ROOT)}: {link}'
            if parsed.fragment and target in docs:
                assert unquote(parsed.fragment) in docs[target].ids, f'Broken anchor {link}'
            checked+=1
    css=(ROOT/'assets/styles.css').read_text(encoding='utf-8')
    assert '@media(max-width:620px)' in css and 'prefers-reduced-motion' in css
    assert 'COMING SOON' in (ROOT/'games/miner/index.html').read_text(encoding='utf-8')
    subprocess.run(['node','--check',str(ROOT/'assets/xr-check.js')],check=True)
    print(f'PASS: {len(docs)} HTML pages, {checked} local links/assets, metadata, responsive rules and JavaScript syntax. Actual game/headset testing is outside this shell check.')

if __name__=='__main__': check()
