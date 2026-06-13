"""tkads 报告生成"""
import sys, os, json
from datetime import datetime, timedelta

sys.path.insert(0, os.path.expanduser('~/.tkads'))
import db

def generate(report_type='daily'):
    snapshots = db.get_latest_snapshots()
    hours = {'daily': 24, 'weekly': 168, 'monthly': 720}
    recent_ops = db.get_recent_ops(hours.get(report_type, 24))
    
    total_cost = sum(float(s.get('cost', 0) or 0) for s in snapshots)
    active = sum(1 for s in snapshots if s.get('status') in ['delivery_ok', 'Active'])
    deleted = sum(1 for s in snapshots if s.get('status') == 'delete')
    paused = sum(1 for s in snapshots if s.get('status') in ['disable', 'Inactive'])
    
    now = datetime.now().strftime('%Y-%m-%d %H:%M')
    
    report = f"""📊 **TK 广告报表 ({report_type})** — {now}

━━━━━━━━━━━━━━━━━━━━━━
📈 概览
━━━━━━━━━━━━━━━━━━━━━━
• 广告总数: {len(snapshots)}
• 投放中: {active}  暂停: {paused}  已删: {deleted}
• 总花费: ${total_cost:.2f}

━━━━━━━━━━━━━━━━━━━━━━
📋 广告详情
━━━━━━━━━━━━━━━━━━━━━━
"""
    for s in snapshots:
        icon = '✅' if s.get('status') in ['delivery_ok', 'Active'] else ('⏸️' if s.get('status') in ['disable', 'Inactive'] else '🗑️')
        name = (s.get('campaign_name', '') or '??')[:35]
        cost = float(s.get('cost', 0) or 0)
        roi = s.get('roi_target', '?')
        status = s.get('status', '?')
        report += f"""{icon} {name}
   状态={status}  花费=${cost:.2f}  ROI={roi}  SPU={s.get('product_id','')[-12:]}
"""

    if recent_ops:
        report += """━━━━━━━━━━━━━━━━━━━━━━
📝 近期操作
━━━━━━━━━━━━━━━━━━━━━━
"""
        for op in recent_ops[:15]:
            ts = (op.get('timestamp', '') or '')[-8:]
            act = op.get('action_type', '')
            cid = ((op.get('campaign_id', '') or '')[-8:])
            report += f"  [{ts}] {act} {cid}\n"
    
    return report

if __name__ == '__main__':
    rtype = sys.argv[1] if len(sys.argv) > 1 else 'daily'
    print(generate(rtype))
