#!/usr/bin/env python3
"""每日广告数据采集（跳过今天，跳过已有）"""
import subprocess, sqlite3, os
from datetime import datetime, timedelta

sys.path.insert(0, os.path.expanduser('~/.tkads'))
from config_chain import config

home = os.path.expanduser("~")
db_path = os.path.join(home, ".tkads", "data", "analytics.db")

# 显示店铺名
print(f"🏪 店铺: {config.get('shop_name')}")

# 计算日期范围：从最早缺失到昨天
today = datetime.now().strftime("%Y-%m-%d")
yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
thirty_days_ago = (datetime.now() - timedelta(days=31)).strftime("%Y-%m-%d")

# 检查已有数据
conn = sqlite3.connect(db_path)
existing = set(r[0] for r in conn.execute("SELECT date FROM daily_stats").fetchall())
conn.close()

# 确定采集范围：最近31天到昨天，跳过已有的
start = thirty_days_ago
end = yesterday
print(f"📅 采集范围: {start} ~ {end} (跳过今天={today}, 已有={len(existing)}天)")

# 运行采集脚本
result = subprocess.run(
    ["python", os.path.join(home, ".tkads", "collect_day_by_day.py"), start, end],
    capture_output=True, text=True, timeout=300
)
print(result.stdout)
if result.stderr:
    print(f"STDERR: {result.stderr[:500]}")

# 输出最新数据摘要
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT * FROM daily_stats ORDER BY date DESC LIMIT 7").fetchall()
conn.close()

print(f"\n📊 最近7天数据:")
print(f"{'日期':<12} {'消耗':>8} {'订单':>5} {'收入':>10} {'ROI':>6}")
print("-" * 45)
for r in reversed(rows):
    print(f"{r['date']:<12} ${r['cost']:>6.2f} {r['orders']:>5} ${r['revenue']:>8.2f} {r['roi']:>5.2f}")

total_cost = sum(r["cost"] for r in rows)
total_orders = sum(r["orders"] for r in rows)
total_revenue = sum(r["revenue"] for r in rows)
print("-" * 45)
print(f"{'近7天合计':<12} ${total_cost:>6.2f} {total_orders:>5} ${total_revenue:>8.2f}")
