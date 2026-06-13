#!/usr/bin/env python3
import urllib.request, json

url = 'https://open.feishu.cn/open-apis/bot/v2/hook/7fa6f848-b53f-40bb-a5f3-cf2b393cfb6a'

card = {
    "msg_type": "interactive",
    "card": {
        "header": {
            "title": {"tag": "plain_text", "content": "🛒 Hanmac.my 达人 & 视频日报"},
            "template": "indigo"
        },
        "elements": [
            # ── 四宫格关键指标 ──
            {
                "tag": "column_set", "flex_mode": "none",
                "background_style": "grey",
                "columns": [
                    {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                        {"tag": "div", "text": {"tag": "lark_md", "content": "📅 **昨日**\n2026-06-11"}}
                    ]},
                    {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                        {"tag": "div", "text": {"tag": "lark_md", "content": "💰 **总收入**\n**$164.78**"}}
                    ]},
                    {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                        {"tag": "div", "text": {"tag": "lark_md", "content": "📦 **总订单**\n**21单**"}}
                    ]},
                    {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                        {"tag": "div", "text": {"tag": "lark_md", "content": "📈 **加权ROI**\n**19.6x**"}}
                    ]}
                ]
            },
            {"tag": "hr"},

            # ── 达人榜单 ──
            {"tag": "div", "text": {"tag": "lark_md", "content": "**👑 达人 TOP 10  (ID后6位)**"}},

            # 表头
            {
                "tag": "column_set", "flex_mode": "none",
                "columns": [
                    {"tag": "column", "width": "weighted", "weight": 3, "elements": [
                        {"tag": "div", "text": {"tag": "lark_md", "content": "**达人**"}}
                    ]},
                    {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                        {"tag": "div", "text": {"tag": "lark_md", "content": "**收入**"}}
                    ]},
                    {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                        {"tag": "div", "text": {"tag": "lark_md", "content": "**单**"}}
                    ]},
                    {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                        {"tag": "div", "text": {"tag": "lark_md", "content": "**客单**"}}
                    ]},
                    {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                        {"tag": "div", "text": {"tag": "lark_md", "content": "**曝光**"}}
                    ]}
                ]
            },
            # 前三名带奖牌
            {"tag": "column_set", "flex_mode": "none", "columns": [
                {"tag": "column", "width": "weighted", "weight": 3, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "🥇 nauraalesha10(214881)"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "**$40.49**"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "**4**"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "$10.12"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "986"}}
                ]}
            ]},
            {"tag": "column_set", "flex_mode": "none", "columns": [
                {"tag": "column", "width": "weighted", "weight": 3, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "🥈 izwni__(170351)"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "$33.22"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "3"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "$11.07"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "626"}}
                ]}
            ]},
            {"tag": "column_set", "flex_mode": "none", "columns": [
                {"tag": "column", "width": "weighted", "weight": 3, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "🥉 fafatin711(272106)"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "$21.30"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "2"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "$10.65"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "927"}}
                ]}
            ]},
            # 4-10名
            {"tag": "div", "text": {"tag": "lark_md", "content": "4. sssyarifahhh___(430571) — $12.04 / 2单\n5. mummynor25(106062) — $11.89 / 1单\n6. mzsilencer(044641) — $11.87 / 1单\n7. ciktoiioii(325587) — $8.33 / 3单\n8. sispanda3(386489) — $5.57 / 1单\n9. noor_ain1993(186022) — $5.56 / 1单\n10. bainunbakry(302541) — $5.51 / 1单"}},
            {"tag": "hr"},

            # ── 视频榜单 ──
            {"tag": "div", "text": {"tag": "lark_md", "content": "**🎬 视频 TOP 5**"}},
            # 视频前三带火箭emoji（ROI高的）
            {"tag": "column_set", "flex_mode": "none", "columns": [
                {"tag": "column", "width": "weighted", "weight": 2, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "🥇 26927637"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "**$23.51**"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "1"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "🚀 44.4x"}}
                ]}
            ]},
            {"tag": "column_set", "flex_mode": "none", "columns": [
                {"tag": "column", "width": "weighted", "weight": 2, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "🥈 01537813"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "$21.30"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "2"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "27.1x"}}
                ]}
            ]},
            {"tag": "column_set", "flex_mode": "none", "columns": [
                {"tag": "column", "width": "weighted", "weight": 2, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "🥉 89124372"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "$16.75"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "2"}}
                ]},
                {"tag": "column", "width": "weighted", "weight": 1, "elements": [
                    {"tag": "div", "text": {"tag": "lark_md", "content": "6.6x"}}
                ]}
            ]},
            {"tag": "div", "text": {"tag": "lark_md", "content": "4. 77636373 — $16.47 / 1单 / ROI 55.4x\n5. 70318100 — $11.89 / 1单 / ROI **324.6x** 🔥"}},
            {"tag": "hr"},

            # ── 底部双栏 ──
            {
                "tag": "column_set", "flex_mode": "bisect",
                "columns": [
                    {
                        "tag": "column", "width": "weighted", "weight": 1,
                        "elements": [
                            {"tag": "div", "text": {"tag": "lark_md", "content": "⭐ **高转化达人**\n\n• izwni__(170351)\n  客单价 $11.07 | 收入 $33.22\n\n• nauraalesha10(214881)\n  客单价 $10.12 | 收入 $40.49"}}
                        ]
                    },
                    {
                        "tag": "column", "width": "weighted", "weight": 1,
                        "elements": [
                            {"tag": "div", "text": {"tag": "lark_md", "content": "📊 **数据概览**\n\n👥 达人: **20位**\n🎬 视频: **20条**\n💰 总收入: **$164.78**\n📦 总订单: **21单**\n📈 加权ROI: **19.6x**\n🏷️ ID显示后6位"}}
                        ]
                    }
                ]
            },
            {"tag": "hr"},
            {"tag": "note", "elements": [
                {"tag": "plain_text", "content": "🤖 由 Hermes Agent 自动生成 | 数据: TikTok Manage-Analyze | 每日09:00推送"}
            ]}
        ]
    }
}

payload = json.dumps(card).encode('utf-8')
req = urllib.request.Request(url, data=payload, headers={'Content-Type': 'application/json'})
resp = urllib.request.urlopen(req, timeout=15)
print("推送结果:", resp.read().decode())
