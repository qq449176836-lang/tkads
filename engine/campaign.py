"""
tkads - 广告操作层
"""
import os
import sys
import json
import time
import subprocess
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db
from api import TikTokSession

class TkAds:
    def __init__(self):
        self.session = None
    
    def connect(self):
        print('🔌 连接浏览器...')
        self.session = TikTokSession()
        self.session.connect()
        return self
    
    def close(self):
        if self.session:
            self.session.disconnect()
    
    def snapshot_all(self):
        """采集所有广告数据并存入数据库"""
        campaigns = self.session.get_campaign_list()
        if not campaigns:
            print('  ⚠️ API 获取失败')
            return 0
        
        count = 0
        for c in campaigns:
            name = c.get('campaign_name', '') or c.get('name', '')
            cid = c.get('campaign_id', '') or c.get('id', '')
            status = c.get('campaign_primary_status', '') or c.get('status', '')
            cost = float(c.get('cost', 0) or 0)
            roi_raw = c.get('campaign_target_roi_budget', 0) or 0
            budget = float(c.get('budget', 0) or 0)
            db.save_snapshot(cid, name, status, budget, float(roi_raw), cost, raw_data=c)
            count += 1
        
        db.log_operation('snapshot', notes=f'已保存 {count} 个广告快照')
        return count
    
    def pause(self, cid, reason=''):
        r = self.session.update_status(cid, 2)
        ok = r.get('code') == 0
        db.log_operation('pause', cid, notes=reason or None, result=r)
        return ok, r
    
    def resume(self, cid):
        r = self.session.update_status(cid, 1)
        ok = r.get('code') == 0
        db.log_operation('resume', cid, result=r)
        return ok, r
    
    def delete(self, cid):
        r = self.session.update_status(cid, 3)
        ok = r.get('code') == 0
        db.log_operation('delete', cid, result=r)
        return ok, r
    
    def list_all(self):
        campaigns = self.session.get_campaign_list()
        if not campaigns:
            print('  ⚠️ 获取失败')
            return []
        
        print(f'\n📋 广告列表 ({len(campaigns)} 个):')
        for c in sorted(campaigns, key=lambda x: x.get('campaign_id', ''), reverse=True):
            name = (c.get('campaign_name', '') or '??')[:35]
            status = c.get('campaign_primary_status', '?') or '?'
            cid = c.get('campaign_id', '') or '?'
            cost = c.get('cost', '0') or '0'
            roi = c.get('campaign_target_roi_budget', '?') or '?'
            print(f'  [{status[:12]:12s}] {name:36s} ROI={roi:>8s} 花费={cost:>8s}  ID={cid}')
        return campaigns
    
    def modify_roi(self, cid, new_roi):
        tz = db.get_tz_id(cid)
        if not tz:
            return False, '未找到时区映射，需先通过创建或编辑捕获 custom_tz_id'
        
        custom_tz_id, tz_type = tz
        body = {
            "campaign_info": {
                "campaign_id": cid,
                "budget_mode": -1,
                "budget": "200.00"
            },
            "ad_info": {
                "ad_id": cid,
                "custom_tz_id": custom_tz_id,
                "custom_tz_type": tz_type,
                "roas_bid": str(new_roi)
            },
            "roas_bid": str(new_roi)
        }
        
        r = self.session.update_ad(body)
        ok = r.get('code') == 0
        db.log_operation('modify_roi', cid, params={'new_roi': new_roi}, result=r)
        return ok, r
    
    def create_ad(self, roi='5.6', budget='200', name=None):
        """通过 UI 创建广告"""
        if name is None:
            name = f'Hanmac_{datetime.now().strftime("%m%d_%H%M")}'
        
        script = os.path.expanduser('~/.hermes/skills/ecommerce/adspower-gmvmax/scripts/gmvmax-create.cjs')
        cmd = f'node "{script}" --roi {roi} --budget {budget} --name "{name}"'
        
        print(f'  执行创建...')
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=120)
        print(result.stdout[:500])
        
        success = '🎉' in result.stdout or '创建成功' in result.stdout
        
        if success:
            # 自动采集新广告数据
            print('\n  创建成功，采集数据中...')
            time.sleep(5)
            camps = self.session.get_campaign_list()
            if camps:
                # 按 ID 排序取最新
                camps_sorted = sorted(camps, key=lambda c: int(c.get('campaign_id', 0) or 0), reverse=True)
                newest = camps_sorted[0]
                new_id = newest.get('campaign_id', '')
                new_name = newest.get('campaign_name', '')
                print(f'  新广告: {new_name} (ID={new_id})')
                
                # 保存快照
                db.save_snapshot(
                    new_id, new_name,
                    newest.get('campaign_primary_status', ''),
                    float(newest.get('budget', 0) or 0),
                    float(newest.get('campaign_target_roi_budget', 0) or 0),
                    float(newest.get('cost', 0) or 0)
                )
                db.log_operation('create', new_id, params={'roi': roi, 'budget': budget, 'name': name},
                               notes='通过 UI 创建成功')
                return True, {'campaign_id': new_id, 'name': new_name}
        
        db.log_operation('create_failed', notes=f'roi={roi}, name={name}')
        return False, result.stdout[:500]
    
    def generate_report(self):
        """生成日报"""
        snapshots = db.get_latest_snapshots()
        recent_ops = db.get_recent_ops(48)
        
        total_cost = sum(s.get('cost', 0) or 0 for s in snapshots)
        active = sum(1 for s in snapshots if s.get('status') in ['delivery_ok', 'Active'])
        
        now = datetime.now().strftime('%Y-%m-%d %H:%M')
        
        report = f"📊 **TK 广告日报** — {now}\n\n"
        report += f"━━━━━━━━━━━━━━━━━━━\n"
        report += f"📈 概览\n"
        report += f"━━━━━━━━━━━━━━━━━━━\n"
        report += f"• 广告总数: {len(snapshots)}\n"
        report += f"• 投放中: {active}\n"
        report += f"• 总花费: ${total_cost:.2f}\n\n"
        report += f"━━━━━━━━━━━━━━━━━━━\n"
        report += f"📋 详情\n"
        report += f"━━━━━━━━━━━━━━━━━━━\n"
        
        for s in snapshots:
            icon = '✅' if s.get('status') in ['delivery_ok', 'Active'] else '⏸️'
            icon = '🗑️' if s.get('status') == 'delete' else icon
            report += f"{icon} {(s.get('campaign_name','') or '??')[:36]}\n"
            report += f"   状态={s.get('status','?')}  花费=${(s.get('cost',0) or 0):.2f}\n"
        
        if recent_ops:
            report += f"\n📝 近期操作 ({len(recent_ops)} 条)\n"
            for op in recent_ops[:10]:
                ts = (op.get('timestamp','') or '')[-8:]
                act = op.get('action_type','')
                cid = (op.get('campaign_id','') or '')[-8:]
                report += f"  [{ts}] {act} {cid}\n"
        
        return report
