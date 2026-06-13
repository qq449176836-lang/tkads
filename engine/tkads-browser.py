#!/usr/bin/env python3
"""
tkads-browser.py — GMV Max 自动化 v3.0 (B方案)
 
直接用 Puppeteer 控制浏览器操作 Seller Center，
告别手动复制粘贴 fetch() 代码。

用法:
  python tkads-browser.py open           # 打开 Hanmac 浏览器
  python tkads-browser.py list           # 列出广告（含详情）
  python tkads-browser.py update <id> <roi> [budget]  # 改 ROI/预算
  python tkads-browser.py pause <id>     # 暂停广告
  python tkads-browser.py resume <id>    # 启动广告
  python tkads-browser.py batch <roi>    # 批量改所有广告 ROI
  python tkads-browser.py daily          # 执行每日采集+报表
  python tkads-browser.py db-list        # 列出本地数据库元数据
  python tkads-browser.py gen-code <id> <roi> [budget]  # 仅生成 fetch 代码
"""

import sys, os, json, time, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db
from api import build_update_body, generate_fetch_code, list_meta

import asyncio
from pyppeteer import connect

# ===== 配置 =====
PROFILE_ID = 'k1456ta2'
ADSPOWER_API = 'http://127.0.0.1:50325'
SELLER_BASE = 'https://seller-my.tiktok.com'
SELLER_ID = '7494105016200037977'
AADVID = '7569565674088136705'
DEBUG_PORT = 63098
WS_URL = f'ws://127.0.0.1:{DEBUG_PORT}/devtools/browser/8d5aa1fe-c7d4-47a6-a58e-595ec3d66443'


# ===== 浏览器管理 =====

async def open_browser():
    import urllib.request
    url = (f"{ADSPOWER_API}/api/v1/browser/start"
           f"?user_id={PROFILE_ID}"
           f"&open_urls={urllib.request.quote(SELLER_BASE)}")
    with urllib.request.urlopen(url, timeout=15) as resp:
        data = json.loads(resp.read())
    if data['code'] != 0:
        raise RuntimeError(f"AdsPower error: {data}")
    ws = data['data']['ws']['puppeteer']
    print(f"✅ 浏览器已打开 (端口 {data['data']['debug_port']})")
    return ws

async def get_browser():
    try:
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json/version", timeout=3):
            print(f"✅ 浏览器已在运行")
            return WS_URL
    except:
        return await open_browser()

async def ensure_page(browser):
    for p in await browser.pages():
        if 'seller-my.tiktok.com' in p.url:
            return p
    page = await browser.newPage()
    await page.goto(SELLER_BASE, {'waitUntil': 'networkidle0', 'timeout': 30000})
    return page


# ===== API 调用（在页面内 fetch）=====

async def api_call(page, endpoint, payload=None):
    """在 Seller Center 页面内执行 fetch()，自动带 Cookie 认证"""
    payload_str = json.dumps(payload, ensure_ascii=False) if payload else '{}'
    js = f"""
    (async () => {{
        const url = '{endpoint}?locale=zh&language=zh&oec_seller_id={SELLER_ID}&aadvid={AADVID}';
        const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
        const res = await fetch(url, {{
            method: 'POST', credentials: 'include',
            headers: {{'Content-Type': 'application/json', 'x-csrftoken': csrf}},
            body: {json.dumps(payload_str)}
        }});
        return await res.text();
    }})()
    """
    raw = await page.evaluate(js, force_expr=True)
    return json.loads(raw)


# ===== 广告操作 =====

async def get_campaigns(page):
    """获取广告详细列表（含名称/状态/ROI/预算等）"""
    payload = {
        "query_list": [
            "campaign_name", "campaign_primary_status", "campaign_id",
            "cost", "campaign_target_roi_budget", "create_time",
            "template_ad_start_time", "template_ad_roas_bid"
        ],
        "page": 1, "page_size": 200
    }
    return await api_call(page, '/oec_ads/shopping/v1/oec/stat/post_campaign_list', payload)

async def do_update(page, body):
    return await api_call(page, '/oec_ads/shopping/v1/creation/all_ad_data/update', body)

async def do_toggle(page, campaign_id, op):
    """暂停(op=2) / 启动(op=1)"""
    return await api_call(page, '/oec_ads/shopping/v1/creation/campaign/update_status',
                         {"campaign_list": [campaign_id], "operation": op})


# ===== 打印 =====

def print_campaigns(data):
    rows = data.get('data', {}).get('table', [])
    if not rows:
        print("  (列表为空)")
        return
    print(f"\n📊 GMV Max 广告 ({len(rows)} 个):")
    print("=" * 90)
    for c in rows:
        cid = c.get('campaign_id', '?')
        name = (c.get('campaign_name', '') or '?')[:30]
        status = c.get('campaign_primary_status_name', c.get('campaign_primary_status', '?'))
        roi = c.get('roas_bid', c.get('template_ad_roas_bid', '?'))
        budget = c.get('budget', c.get('campaign_target_roi_budget', '?'))
        cost = c.get('cost', '0')
        print(f"  {cid}")
        print(f"    名称: {name}")
        print(f"    状态: {status} | ROI: {roi} | 预算: {budget} | 花费: {cost}")
        print()


# ===== CLI =====

async def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'help'
    
    if cmd == 'open':
        await open_browser()
        print(f"\n  然后: python tkads-browser.py list")
        return
    
    if cmd == 'help' or cmd == '--help':
        print(__doc__.strip())
        return
    
    if cmd == 'db-list':
        list_meta()
        return
    
    if cmd == 'gen-code':
        """仅生成 fetch 代码（不连浏览器）"""
        if len(sys.argv) < 4:
            print("用法: python tkads-browser.py gen-code <campaign_id> <new_roi> [new_budget]")
            return
        cid = sys.argv[2]
        roi = float(sys.argv[3])
        budget = float(sys.argv[4]) if len(sys.argv) > 4 else None
        meta = db.get_campaign_meta(cid)
        if not meta:
            print(f"❌ 未找到元数据: {cid}")
            return
        body = build_update_body(meta, roi, budget)
        code = generate_fetch_code(body, cid)
        print(code)
        return
    
    if cmd == 'daily':
        """执行每日数据采集"""
        from save_snapshot import save_snapshots
        from report_gen import gen_report
        
        ws_url = await get_browser()
        browser = await connect(browserWSEndpoint=ws_url)
        try:
            page = await browser.newPage()
            await page.goto(f'{SELLER_BASE}/ads-creation/dashboard?mpa=1',
                          {'waitUntil': 'networkidle0', 'timeout': 30000})
            await asyncio.sleep(6)
            
            result = await get_campaigns(page)
            if result.get('code') == 0 and result.get('data', {}).get('table'):
                camps = result['data']['table']
                print(f'  采集 {len(camps)} 个广告')
                save_snapshots(camps)
                
                # 生成报表
                report_type = sys.argv[3] if len(sys.argv) > 3 else 'daily'
                report = gen_report(report_type)
                print(f'\n{report}')
                
                # 保存
                report_dir = os.path.expanduser('~/.tkads/reports')
                os.makedirs(report_dir, exist_ok=True)
                fname = f'{report_dir}/{report_type}-{time.strftime("%Y-%m-%d")}.md'
                with open(fname, 'w', encoding='utf-8') as f:
                    f.write(report)
                print(f'\n报告: {fname}')
            else:
                print(f'❌ 获取失败: {result.get("msg", json.dumps(result)[:100])}')
        finally:
            await browser.disconnect()
        return
    
    # 以下需要连接浏览器
    ws_url = await get_browser()
    browser = await connect(browserWSEndpoint=ws_url)
    
    try:
        page = await ensure_page(browser)
        print(f"   页面: {page.url[:80]}")
        
        if cmd == 'list':
            r = await get_campaigns(page)
            print_campaigns(r) if r.get('code') == 0 else print(f"❌ {r}")
        
        elif cmd == 'update':
            if len(sys.argv) < 4: print("用法: update <id> <roi> [budget]"); return
            cid, new_roi = sys.argv[2], float(sys.argv[3])
            budget = float(sys.argv[4]) if len(sys.argv) > 4 else None
            meta = db.get_campaign_meta(cid)
            if not meta: print(f"❌ 未找到元数据: {cid}"); return
            if not meta.get('ad_id') or not meta.get('start_time'):
                print(f"⚠️ 元数据不完整，先 python tkads-browser.py gen-code")
                return
            body = build_update_body(meta, new_roi, budget)
            print(f"\n修改: {meta.get('product_name', cid)} → ROI={new_roi}")
            r = await do_update(page, body)
            if r.get('code') == 0:
                print(f"✅ 成功!")
                db.log_operation('update_v3', cid, {'roi': new_roi, 'budget': budget})
            else:
                print(f"❌ 失败: {json.dumps(r, ensure_ascii=False)}")
        
        elif cmd == 'pause' or cmd == 'resume':
            if len(sys.argv) < 3: print(f"用法: {cmd} <campaign_id>"); return
            cid, op = sys.argv[2], 2 if cmd == 'pause' else 1
            label = '暂停' if cmd == 'pause' else '启动'
            print(f"{label}: {cid}")
            r = await do_toggle(page, cid, op)
            print(f"✅ {label}成功!" if r.get('code') == 0 else f"❌ 失败: {r.get('msg','?')}")
            if r.get('code') == 0:
                db.log_operation(f'{cmd}_v3', cid, {'op': op})
        
        elif cmd == 'batch':
            target_roi = float(sys.argv[2]) if len(sys.argv) > 2 else 3.0
            metas = db.get_all_meta()
            if not metas: print("❌ 无元数据"); return
            print(f"\n批量 {len(metas)} 个广告 → ROI={target_roi}")
            ok, fail = 0, 0
            for m in metas:
                if not m.get('ad_id') or not m.get('start_time'):
                    print(f"  ⏭ {m['campaign_id']}: 元数据不完整"); continue
                body = build_update_body(m, target_roi)
                r = await do_update(page, body)
                if r.get('code') == 0:
                    ok += 1; print(f"  ✅ {m['campaign_id']}")
                else:
                    fail += 1; print(f"  ❌ {m['campaign_id']}: {r.get('msg','?')}")
                await asyncio.sleep(0.5)
            print(f"\n✅ {ok} 成功, ❌ {fail} 失败")
        
        else:
            print(f"未知命令: {cmd}")
            print(__doc__.strip())
    
    finally:
        await browser.disconnect()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n已取消")
    except Exception as e:
        print(f"\n❌ 错误: {e}")
        import traceback
        traceback.print_exc()
