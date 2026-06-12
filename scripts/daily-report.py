#!/usr/bin/env python3
"""生成 GMV Max 广告日报，并推送到飞书"""
import sqlite3, os, subprocess, json, urllib.request, sys
from datetime import datetime, timedelta
from io import StringIO

# ── 统一配置加载（含 fallback） ──
try:
    SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
    if SCRIPT_DIR not in sys.path:
        sys.path.insert(0, SCRIPT_DIR)
    from store_config import get_store, get_webhook
    from store_utils import capture_output, get_db
    _store = get_store()
    SHOP_NAME = _store.get("name", "Hanmac.my")
    DB_PATH = _store.get("paths", {}).get("db",
        os.path.join(os.path.expanduser("~"), ".tkads", "data", "analytics.db"))
    _REPORT_WEBHOOK = get_webhook("hanmac_my", "report")
except Exception as _e:
    # fallback: 旧值
    print(f"[config fallback] {_e}", file=sys.stderr)
    SHOP_NAME = "Hanmac.my"
    DB_PATH = os.path.join(os.path.expanduser("~"), ".tkads", "data", "analytics.db")
    _REPORT_WEBHOOK = None

# ── 旧版 webhook 降级（从环境变量或文件） ──
if not _REPORT_WEBHOOK:
    _REPORT_WEBHOOK = os.environ.get("FEISHU_BOT_WEBHOOK")
if not _REPORT_WEBHOOK:
    _cfg_path = os.path.join(os.path.expanduser("~"), ".hermes", "scripts", ".report_webhook")
    if os.path.exists(_cfg_path):
        with open(_cfg_path) as _f:
            _REPORT_WEBHOOK = _f.read().strip()

today = datetime.now().strftime("%Y-%m-%d")
yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

# 捕获所有输出
out = StringIO()
_print = print
def print(*a, **kw):
    _print(*a, **kw)
    kw.pop('file', None)
    _print(*a, file=out, **kw)

# 读取数据库
conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row

# 昨天数据
y_row = conn.execute("SELECT * FROM daily_stats WHERE date=?",
    (yesterday,)).fetchone()

# 近7天数据
week_rows = conn.execute(
    "SELECT * FROM daily_stats ORDER BY date DESC LIMIT 7").fetchall()

# 近30天汇总
month_rows = conn.execute(
    "SELECT * FROM daily_stats ORDER BY date ASC").fetchall()
conn.close()

# 格式化输出
print(f"━━━ {SHOP_NAME} GMV Max 广告日报 ━━━")
print(f"📅 {today}")
print()

# 昨日表现
if y_row:
    y_roi = y_row['roi'] if y_row['roi'] > 0 else 0
    print(f"📊 昨日 ({yesterday})")
    print(f"   消耗: ${y_row['cost']:.2f}  |  订单: {y_row['orders']}  |  收入: ${y_row['revenue']:.2f}  |  ROI: {y_roi:.2f}")
else:
    print(f"📊 昨日 ({yesterday})")
    print("   ⏳ 数据尚未采集")
print()

# 近7天趋势
print(f"📈 近7天趋势")
print(f"{'日期':<12} {'消耗':>8} {'订单':>5} {'收入':>10} {'ROI':>6}")
print("-" * 45)
for r in sorted(week_rows, key=lambda x: x['date']):
    roi = r['roi'] if r['roi'] > 0 else 0
    print(f"{r['date']:<12} ${r['cost']:>6.2f} {r['orders']:>5} ${r['revenue']:>8.2f} {roi:>5.2f}")

avg_cost = sum(r['cost'] for r in week_rows) / len(week_rows) if week_rows else 0
avg_orders = sum(r['orders'] for r in week_rows) // len(week_rows) if week_rows else 0
total_rev = sum(r['revenue'] for r in week_rows)
total_cost_week = sum(r['cost'] for r in week_rows)
total_orders_week = sum(r['orders'] for r in week_rows)
print("-" * 45)
print(f"{'日均/合计':<12} ${avg_cost:>6.2f} {avg_orders:>5} ${total_rev:>8.2f}")
print()

# 30天汇总
total_cost = sum(r['cost'] for r in month_rows)
total_orders = sum(r['orders'] for r in month_rows)
total_revenue = sum(r['revenue'] for r in month_rows)
avg_roi = total_revenue / total_cost if total_cost > 0 else 0
days = len(month_rows)
print(f"📊 近{days}天汇总")
print(f"   总消耗: ${total_cost:.2f}  |  总订单: {total_orders}  |  总收入: ${total_revenue:.2f}  |  平均ROI: {avg_roi:.2f}")
print(f"   日均: ${total_cost/days:.2f}  |  {total_orders//days}单  |  ${total_revenue/days:.2f}")
print()

# 获取当前广告列表（通过 tkads-list）
try:
    result = subprocess.run(
        ["node", os.path.join(os.path.expanduser("~"), ".tkads", "tkads.js"), "list", "7"],
        capture_output=True, text=True, timeout=120
    )
    print(f"🎯 当前广告状态")
    print(result.stdout)
except Exception as e:
    print(f"🎯 当前广告状态")
    print(f"   未能获取: {e}")

print(f"━━━━━━━━━━━━━━━━━")

# 推送到飞书
report_text = out.getvalue()
print(report_text)  # 同时输出到 stdout

FEISHU_WEBHOOK = _REPORT_WEBHOOK
if FEISHU_WEBHOOK:
    payload = json.dumps({
        "msg_type": "text",
        "content": {"text": report_text}
    }).encode("utf-8")
    req = urllib.request.Request(
        FEISHU_WEBHOOK,
        data=payload,
        headers={"Content-Type": "application/json"}
    )
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        resp_body = resp.read().decode()
        print(f"[Feishu] 推送完成: {resp_body}")
    except Exception as e:
        print(f"[Feishu] 推送失败: {e}")
else:
    print("[Feishu] 未配置 Webhook，跳过推送")
