#!/usr/bin/env python3
"""
Build lib/geo/data/us-places.json from the Census Gazetteer place file.

  curl -LO https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_place_national.zip
  unzip 2024_Gaz_place_national.zip
  python3 scripts/build-us-places.py 2024_Gaz_place_national.txt

Output: {"ames, ia": ["Ames, IA", 42.0263, -93.6213], ...} for the contiguous
48 states plus DC (Lime Media does not serve AK, HI or PR). Names lose the
Census suffix ("Ames city" -> "Ames"); "Nashville-Davidson" also answers to
"Nashville", "Boise City" to "Boise". Keys drop periods
("st louis, mo"); the display name keeps them ("St. Louis, MO"). Where two places share a name in a
state, the incorporated one wins, then the larger.
"""
import json, re, sys

SUFFIX = re.compile(r'\s+(city and borough|consolidated government|unified government|metropolitan government|metro government|urban county|city|town|village|CDP|borough|municipality|township|plantation|corporation|comunidad|zona urbana)$', re.I)
best = {}
for i, line in enumerate(open(sys.argv[1], encoding='utf-8', errors='replace')):
    if i == 0:
        continue
    f = line.rstrip('\n').split('\t')
    st, name, funcstat, aland = f[0].strip(), f[3].strip(), f[5].strip(), int(f[6] or 0)
    if st in ('AK', 'HI', 'PR'):
        continue
    lat, lng = round(float(f[10]), 4), round(float(f[11]), 4)
    n = SUFFIX.sub('', re.sub(r'\s*\(balance\)\s*$', '', name)).strip()
    names = {n: 1}
    for sep in ('-', '/'):
        if sep in n:
            names.setdefault(n.split(sep)[0].strip(), 0)
    if n.endswith(' City') and len(n) > 5:
        names.setdefault(n[:-5].strip(), 0)
    for nm, full in names.items():
        if not nm:
            continue
        # Periods dropped, exactly as lib/geo/places.ts key() normalizes input:
        # "St. Louis" and "St Louis" both reach "st louis, mo".
        k = f"{nm.lower().replace('.', '')}, {st.lower()}"
        r = (full, 1 if funcstat == 'A' else 0, aland)
        if k not in best or r > best[k][0]:
            best[k] = (r, [f"{nm}, {st}", lat, lng])
out = {k: v[1] for k, v in sorted(best.items())}
json.dump(out, open('lib/geo/data/us-places.json', 'w'), separators=(',', ':'), ensure_ascii=False)
print(len(out), 'places')
