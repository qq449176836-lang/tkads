#!/usr/bin/env python3
"""达人 & 视频日报 — 卡片推送飞书"""
import sqlite3, os, json, urllib.request, sys
from datetime import datetime, timedelta
from io import StringIO

try:
    SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
    if SCRIPT_DIR not in sys.path:
        sys.path.insert(0, SCRIPT_DIR)
    from store_config import get_store, get_webhook
    _store = get_store()
    SHOP_NAME = _store.get("name", "Hanmac.my")
    DB_PATH = _store.get("paths", {}).get("db",
        os.path.join(os.path.expanduser("~"), ".tkads", "data", "analytics.db"))
    _REPORT_WEBHOOK = get_webhook("hanmac_my", "report")
except Exception:
    SHOP_NAME = "Hanmac.my"
    DB_PATH = os.path.join(os.path.expanduser("~"), ".tkads", "data", "analytics.db")
    _REPORT_WEBHOOK = None

if not _REPORT_WEBHOOK:
    _REPORT_WEBHOOK = os.environ.get("FEISHU_BOT_WEBHOOK")
if not _REPORT_WEBHOOK:
    _cfg_path = os.path.join(os.path.expanduser("~"), ".hermes", "scripts", ".report_webhook")
    if os.path.exists(_cfg_path):
        with open(_cfg_path) as f:
            _REPORT_WEBHOOK = f.read().strip()

today = datetime.now().strftime("%Y-%m-%d")
yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row
creators = conn.execute("SELECT * FROM creators ORDER BY revenue DESC LIMIT 100").fetchall()
if len(creators) == 0:
    creators = conn.execute("SELECT * FROM creators_30d ORDER BY revenue DESC").fetchall()
posts = conn.execute("SELECT * FROM posts ORDER BY revenue DESC LIMIT 100").fetchall()
if len(posts) == 0:
    posts = conn.execute("SELECT * FROM posts_30d ORDER BY revenue DESC").fetchall()
conn.close()


def clean_name(raw):
    if not raw: return "?"
    c = raw.strip()
    half = len(c) // 2
    if len(c) >= 4 and c[:half] == c[half:]:
        c = c[:half]
    return c


def nl(text):
    """用HTML的<br>换行（飞书lark_md支持）"""
    return text.replace("\n", "<br>")


def build_card(creators, posts):
    total_rev_c = sum(r['revenue'] for r in creators)
    total_ord_c = sum(r['orders'] for r in creators)
    total_rev_p = sum(r['revenue'] for r in posts)
    total_ord_p = sum(r['orders'] for r in posts)
    total_cost_p = sum(r['cost'] for r in posts if r['cost'] and r['cost'] > 0)
    weighted_roi = total_rev_p / total_cost_p if total_cost_p > 0 else 0

    high_performers = [r for r in creators if r['revenue'] >= 20 and r['orders'] >= 3]
    high_performers.sort(key=lambda x: x['revenue'] / x['orders'] if x['orders'] > 0 else 0, reverse=True)

    cid = lambda r: (r['creator_id'] or '')[-6:]
    md = lambda s: {"tag": "div", "text": {"tag": "lark_md", "content": s}}

    medals = ["1f949", "1f948", "1f947"]  # 🥇🥈🥉
    medal_emojis = ["\U0001F947", "\U0001F948", "\U0001F949"]

    elements = [
        # ── 四宫格指标 ──
        {
            "tag": "column_set", "flex_mode": "none", "background_style": "grey",
            "columns": [
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [md(f"**\U0001F4C5 昨日**<br>{yesterday}")]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [md(f"**\U0001F4B0 总收入**<br>**${total_rev_c:.2f}**")]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [md(f"**\U0001F4E6 总订单**<br>**{total_ord_c}单**")]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [md(f"**\U0001F4C8 加权ROI**<br>**{weighted_roi:.1f}x**")]}
            ]
        },
        {"tag": "hr"},
        md("**\U0001F451 达人 TOP 10  (ID后6位)**"),

        # 达人表头
        {"tag": "column_set", "flex_mode": "none", "columns": [
            {"tag": "column", "width": "weighted", "weight": 3, "elements": [md("**达人**")]},
            {"tag": "column", "width": "weighted", "weight": 1, "elements": [md("**收入**")]},
            {"tag": "column", "width": "weighted", "weight": 1, "elements": [md("**单**")]},
            {"tag": "column", "width": "weighted", "weight": 1, "elements": [md("**客单**")]},
            {"tag": "column", "width": "weighted", "weight": 1, "elements": [md("**曝光**")]}
        ]},
    ]

    # 达人数据行
    for i, r in enumerate(creators[:10]):
        name = clean_name(r['username'])
        medal = medal_emojis[i] if i < 3 else f"{i+1}."
        prefix = medal if i < 3 else f"{i+1}."
        gmv = r['revenue'] / r['orders'] if r['orders'] > 0 else 0
        display_name = f"{name}({cid(r)})" if r['creator_id'] else name
        rev_str = f"**${r['revenue']:.2f}**" if i < 3 else f"${r['revenue']:.2f}"
        elements.append({
            "tag": "column_set", "flex_mode": "none",
            "columns": [
                {"tag": "column", "width": "weighted", "weight": 3, "elements": [md(f"{prefix} {display_name}")]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [md(rev_str)]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [md(str(r['orders']))]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [md(f"${gmv:.2f}")]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [md(str(r['impressions']))]}
            ]
        })

    # ── 视频 ──
    elements += [{"tag": "hr"}, md("**\U0001F3AC 视频 TOP 5**")]

    for i, r in enumerate(posts[:5]):
        pid = str(r['post_id'])[-8:]
        medal = medal_emojis[i] if i < 3 else f"{i+1}."
        roi_val = r['roi'] if r['roi'] else (r['revenue'] / r['cost'] if r['cost'] and r['cost'] > 0 else 0)
        roi_icon = "\U0001F680 " if roi_val > 20 else "\U0001F525 " if roi_val > 10 else ""
        roi_str = f"{roi_icon}{roi_val:.1f}x" if roi_val > 0 else "N/A"
        rev_str = f"**${r['revenue']:.2f}**" if i < 3 else f"${r['revenue']:.2f}"
        elements.append({
            "tag": "column_set", "flex_mode": "none",
            "columns": [
                {"tag": "column", "width": "weighted", "weight": 2, "elements": [md(f"{medal} {pid}")]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [md(rev_str)]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [md(str(r['orders']))]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [md(roi_str)]}
            ]
        })

    # ── 高转化达人 ──
    hp_lines = []
    if high_performers:
        for r in high_performers[:3]:
            gmv = r['revenue'] / r['orders'] if r['orders'] > 0 else 0
            tag = f"({cid(r)})" if r['creator_id'] else ""
            hp_lines.append(f"{clean_name(r['username'])}{tag}<br>  客单价 ${gmv:.2f} | 收入 ${r['revenue']:.2f}")
    hp_text = "<br>".join(hp_lines) if hp_lines else "暂无"

    elements += [
        {"tag": "hr"},
        {
            "tag": "column_set", "flex_mode": "bisect",
            "columns": [
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    md(f"\u2B50 **高转化达人**<br><br>{hp_text}")
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    md(
                        "\U0001F4CA **数据概览**<br><br>"
                        f"\U0001F464 达人: **{len(creators)}位**<br>"
                        f"\U0001F3AC 视频: **{len(posts)}条**<br>"
                        f"\U0001F4B0 总收入: **${total_rev_c:.2f}**<br>"
                        f"\U0001F4E6 总订单: **{total_ord_c}单**<br>"
                        f"\U0001F4C8 加权ROI: **{weighted_roi:.1f}x**<br>"
                        "\U0001F3F7\U0000FE0F ID显示后6位"
                    )
                ]}
            ]
        },
        {"tag": "hr"},
        {"tag": "note", "elements": [
            {"tag": "plain_text", "content": "🤖 由 Hermes Agent 自动生成 | 数据: TikTok Manage-Analyze | 每日09:00推送"}
        ]}
    ]

    return {
        "msg_type": "interactive",
        "card": {
            "header": {
                "title": {"tag": "plain_text", "content": f"\U0001F6D2 {SHOP_NAME} 达人 & 视频日报"},
                "template": "indigo"
            },
            "elements": elements
        }
    }


# ═════ 推送 ═════
card = build_card(creators, posts)
print(f"\U0001F4CB 卡片构建: {len(creators)}达人 / {len(posts)}视频")

if _REPORT_WEBHOOK:
    payload = json.dumps(card, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        _REPORT_WEBHOOK, data=payload,
        headers={"Content-Type": "application/json"}
    )
    max_retries = 3
    for attempt in range(max_retries):
        try:
            resp = urllib.request.urlopen(req, timeout=15)
            result = json.loads(resp.read())
            if result.get("code") == 0 or result.get("StatusCode") == 0:
                print("\u2705 [Feishu] 卡片推送成功")
                break
            elif "frequency" in result.get("msg", "").lower():
                if attempt < max_retries - 1:
                    wait = (attempt + 1) * 2
                    print(f"\u23F3 限流，{wait}秒后重试 ({attempt+1}/{max_retries})...")
                    import time
                    time.sleep(wait)
                else:
                    print(f"\u26A0\uFE0F [Feishu] 限流重试耗尽: {result}")
            else:
                print(f"\u26A0\uFE0F [Feishu] 推送异常: {result}")
                break
        except Exception as e:
            if attempt < max_retries - 1:
                wait = (attempt + 1) * 3
                print(f"\u23F3 推送失败({e})，{wait}秒后重试...")
                import time
                time.sleep(wait)
            else:
                print(f"\u274C [Feishu] 推送失败: {e}")
else:
    print("\u274C [Feishu] 未配置 Webhook")
