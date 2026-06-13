#!/usr/bin/env python3
"""
GMV Max ROI/预算修改工具 v2.0
支持两种模式：
  1. 对已有完整元数据的广告（含 ad_id + start_time）直接修改
  2. 对仅有部分数据的广告手动补充后修改
"""
import json, sys, os
sys.path.insert(0, os.path.expanduser('~/.tkads'))

from config_chain import config
from db import get_campaign_meta, get_all_meta, get_tz_id, log_operation

def build_update_body(meta, new_roi, new_budget=None):
    """根据存储的元数据构建 update API body"""
    roi = float(new_roi)
    budget = float(new_budget) if new_budget else float(meta.get('budget', 200))
    adj_roi = round(roi * 0.9, 1)
    tz_id = meta.get('custom_tz_id') or '7473424031757336583'
    tz_type = meta.get('custom_tz_type') or 1
    
    # 从 product_name 提取 spu_id（最后一段数字）
    name = meta.get('product_name', '')
    spu_id = meta.get('spu_id', '')
    if not spu_id and '-' in name:
        parts = name.split('-')
        spu_id = parts[-1] if parts[-1].isdigit() else ''
    
    body = {
        "campaign_info": {
            "campaign_id": meta['campaign_id'],
            "campaign_name": name,
            "budget_mode": -1,
            "budget": f"{budget:.2f}",
            "shop_automation_type": 2,
            "shop_image_aigc_mode": 0
        },
        "ad_info": {
            "name": name,
            "campaign_id": meta['campaign_id'],
            "ad_id": meta.get('ad_id', ''),
            "inventory_flow_type": 0,
            "inventory_flow": [3000, 9000],
            "inventory_type": [11180001, 11180007, 11180532, 11180533,
                              11233001, 11233007, 11233532, 11233533, 900000000],
            "shopping_inventory_type": 1,
            "external_type": 0,
            "schedule_type": 1,
            "start_time": meta.get('start_time', ''),
            "budget_mode": 0,
            "budget": f"{budget:.2f}",
            "product_video_selection_type": 1,
            "pricing": 9,
            "optimize_goal": 111,
            "external_action": 0,
            "deep_bid_type": 108,
            "roas_bid": str(roi),
            "product_platform_id": "0",
            "country": config.get('country'),
            "shop_id": config.get('shop_id'),
            "shop_authorized_bc": config.get('bc_id'),
            "promotion_flow_type": 5,
            "product_source": 2,
            "product_bid_type": 0,
            "custom_tz_id": tz_id,
            "custom_tz_type": tz_type,
            "promotion_days_setting": {
                "is_enable": True, "automode_enable": True,
                "roas_bid_multiplier": 90, "budget_multiplier": 150,
                "adjusted_budget": int(budget * 1.5),
                "adjusted_roas_bid": str(adj_roi),
                "benchmark_roas_bid": roi,
                "custom_schedules": []
            },
            "compensation_activity_type": 3,
            "gmax_budget_adjust_setting": {
                "auto_budget_switch": False,
                "effective_budget": budget,
                "current_adjust_times": 0,
                "strategy": 2,
                "promotion_day_adjust_config": {
                    "adjust_ratio": 0.5, "max_daily_adjust_times": 10
                }
            },
            "audience": {"brand_safety": 1},
            "product_list": [{"spu_id": spu_id}],
            "product_specific_type": 3,
            "identity_list": [{"tt_uid": config.get('creator_uid'), "identity_type": 8}],
            "custom_anchor_videos": [],
            "shop_aca_mode": 1,
            "enable_shop_video_exclusion_filter": True,
            "shop_video_filters": [],
            "shop_new_creative_exploration": 1,
            "pre_item_list": []
        },
        "risk_info": {
            "cookie_enabled": True,
            "screen_width": 1707, "screen_height": 1067,
            "browser_language": "en-US", "browser_platform": "Win32",
            "browser_name": "Mozilla",
            "browser_version": "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
            "browser_online": True,
            "timezone_name": "Asia/Kuala_Lumpur"
        }
    }
    return body


def generate_fetch_code(body, campaign_id):
    """生成可在浏览器 Console 中执行的 fetch() 代码"""
    body_json = json.dumps(body, ensure_ascii=False)
    code = f'''// ===== GMV Max ROI修改（campaign_id: {campaign_id}）=====
fetch('/oec_ads/shopping/v1/creation/all_ad_data/update?locale=zh&language=zh&oec_seller_id={config.get('shop_id')}&aadvid={config.get('aadvid')}', {{
  method: 'POST',
  credentials: 'include',
  headers: {{
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json; charset=UTF-8',
    'x-csrftoken': document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '',
    'origin': f'https://{config.get("seller_domain")}',
    'referer': window.location.href
  }},
  body: {json.dumps(body_json, ensure_ascii=False)}
}})
.then(r => r.json())
.then(d => console.log('✅ 成功:', JSON.stringify(d, null, 2)))
.catch(e => console.error('❌ 失败:', e));'''
    return code


def list_meta():
    """列出所有有元数据的广告"""
    metas = get_all_meta()
    if not metas:
        print("当前没有已保存的广告元数据。")
        print("使用 gmvmax-create-v4.cjs 创建新广告时会自动保存。")
        return
    
    print(f"{'#':>3} {'campaign_id':<20} {'ad_id':<20} {'start_time':<22} {'spu_id':<22} {'ROI':<8}")
    print("-" * 100)
    for i, m in enumerate(metas, 1):
        ad_id = m.get('ad_id', '') or '(无)'
        start = m.get('start_time', '') or '(无)'
        spu = m.get('spu_id', '') or '(无)'
        roi = m.get('roi_target', 0) or 0
        name = (m.get('product_name', '') or '?')[:20]
        print(f"{i:>3} {m['campaign_id']:<20} {ad_id:<20} {start:<22} {spu:<22} {roi:<8}")
        print(f"    名称: {name}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("=" * 60)
        print("GMV Max ROI 修改工具 v2.0")
        print("=" * 60)
        print()
        print("用法:")
        print("  列出已有元数据: python api.py list")
        print("  修改 ROI:       python api.py update <campaign_id> <new_roi> [new_budget]")
        print()
        list_meta()
        sys.exit(0)
    
    cmd = sys.argv[1]
    
    if cmd == "list":
        list_meta()
    
    elif cmd == "update":
        if len(sys.argv) < 4:
            print("用法: python api.py update <campaign_id> <new_roi> [new_budget]")
            sys.exit(1)
        
        campaign_id = sys.argv[2]
        new_roi = float(sys.argv[3])
        new_budget = float(sys.argv[4]) if len(sys.argv) > 4 else None
        
        meta = get_campaign_meta(campaign_id)
        if not meta:
            print(f"❌ 未找到 campaign_id={campaign_id} 的元数据")
            print("   先创建广告（gmvmax-create-v4.cjs）或手动补充元数据。")
            sys.exit(1)
        
        ad_id = meta.get('ad_id', '') or ''
        start_time = meta.get('start_time', '') or ''
        
        if not ad_id or not start_time:
            print(f"⚠️ 元数据不完整: ad_id={'有' if ad_id else '❌缺失'} start_time={'有' if start_time else '❌缺失'}")
            print("   请在数据库中补充后重试。")
            sys.exit(1)
        
        body = build_update_body(meta, new_roi, new_budget)
        fetch_code = generate_fetch_code(body, campaign_id)
        
        print(f"\n✅ 已生成 fetch() 代码：")
        print(f"   campaign_id={campaign_id}")
        print(f"   ad_id={ad_id}")
        print(f"   start_time={start_time}")
        print(f"   新ROI={new_roi}{f' 新预算={new_budget}' if new_budget else ''}")
        print(f"\n{'='*60}")
        print("📋 复制以下代码到 Seller Center 页面 Console 执行：")
        print(f"{'='*60}")
        print(fetch_code)
        log_operation('generate_update', campaign_id, {'new_roi': new_roi, 'new_budget': new_budget})
