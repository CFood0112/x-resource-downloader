import sys
import urllib.request

url, out_file, cookie_file = sys.argv[1], sys.argv[2], sys.argv[3]
headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'
}

if cookie_file:
    try:
        parts = []
        with open(cookie_file, encoding='utf-8', errors='ignore') as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                cols = line.split('\t')
                if len(cols) >= 7:
                    parts.append(f'{cols[5]}={cols[6]}')
        if parts:
            headers['Cookie'] = '; '.join(parts)
    except Exception:
        pass

req = urllib.request.Request(url, headers=headers)
with urllib.request.urlopen(req, timeout=60) as resp:
    data = resp.read()
with open(out_file, 'wb') as fh:
    fh.write(data)
