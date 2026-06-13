#!/usr/bin/env python3
"""
db_query.py — Hermes Evolution Engine: SQLite query helper for reviewer.js
Called via child_process from Node.js to query the analytics database.
Usage: python3 db_query.py <sql> [param1] [param2] ...
"""
import sqlite3, json, sys, os

if len(sys.argv) < 2:
    print(json.dumps({"error": "Usage: db_query.py <sql> [params...]"}))
    sys.exit(1)

sql = sys.argv[1]
params = sys.argv[2:] if len(sys.argv) > 2 else []

# Convert numeric params
parsed = []
for p in params:
    if p == 'None' or p == 'null':
        parsed.append(None)
    elif p == 'True':
        parsed.append(True)
    elif p == 'False':
        parsed.append(False)
    else:
        try:
            if '.' in p:
                parsed.append(float(p))
            else:
                parsed.append(int(p))
        except ValueError:
            parsed.append(p)

# Locate analytics.db relative to this script or home
home = os.environ.get('HOME', os.environ.get('USERPROFILE', '.'))
db_path = os.path.join(home, '.tkads', 'data', 'analytics.db')

if not os.path.exists(db_path):
    print(json.dumps({"error": f"Database not found: {db_path}"}))
    sys.exit(1)

try:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.execute(sql, parsed)
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    print(json.dumps(rows, ensure_ascii=False, default=str))
except Exception as e:
    print(json.dumps({"error": str(e)}), file=sys.stderr)
    sys.exit(1)
