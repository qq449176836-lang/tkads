#!/usr/bin/env python3
"""
collect/queue_add.py — 手动往采集队列添加任务

用法:
  python3 collect/queue_add.py <job_type> [--now] [--force]

参数:
  job_type  任务类型: store_health | ads_daily | full_rankings | product_analysis | content_daily
  --now     立即执行（设置scheduled_at为当前时间）
  --force   即使今天已有同类型任务也强制添加

示例:
  python3 collect/queue_add.py store_health
  python3 collect/queue_add.py store_health --now
  python3 collect/queue_add.py full_rankings --now --force
  python3 collect/queue_add.py --list           # 查看所有任务类型
"""
import sqlite3, json, sys, os
from datetime import datetime

HOME = os.path.expanduser('~').replace('\\', '/')
TKADS = HOME + '/.tkads'
DB = TKADS + '/data/analytics.db'

TASK_TYPES = {
    'store_health': {'name': '店铺健康采集'},
    'ads_daily': {'name': '广告逐日采集'},
    'full_rankings': {'name': '排名+行业榜单'},
    'product_analysis': {'name': '商品分析采集'},
    'content_daily': {'name': '内容拆分采集'},
}

def main():
    args = sys.argv[1:]
    
    if '--list' in args:
        print('可用的采集任务类型:')
        print(f'  {"类型".ljust(20)} 说明')
        print(f'  {"-" * 40}')
        for jt, cfg in TASK_TYPES.items():
            print(f'  {jt.ljust(20)} {cfg["name"]}')
        return

    if not args or args[0].startswith('--'):
        print(__doc__)
        sys.exit(1)

    job_type = args[0]
    now_tasks = '--now' in args
    force = '--force' in args

    if job_type not in TASK_TYPES:
        print(f'❌ 未知任务类型: {job_type}')
        print(f'   可用类型: {", ".join(TASK_TYPES.keys())}')
        sys.exit(1)

    today = datetime.now().strftime('%Y-%m-%d')
    now_str = datetime.now().isoformat()
    
    conn = sqlite3.connect(DB)
    cur = conn.cursor()

    # 检查是否已有今日同类型任务
    if not force:
        cur.execute(
            "SELECT id, status FROM collect_queue WHERE job_type=? AND scheduled_at LIKE ? AND status NOT IN ('cancelled')",
            (job_type, f'{today}%')
        )
        existing = cur.fetchone()
        if existing:
            print(f'⏭️  {TASK_TYPES[job_type]["name"]}: 今日已有任务 (#{existing[0]}, 状态={existing[1]})')
            print(f'   如需强制添加请加 --force')
            conn.close()
            return

    scheduled_at = now_str if now_tasks else f'{today}T06:30:00'
    
    cur.execute(
        "INSERT INTO collect_queue (job_type, params, status, priority, scheduled_at, created_at) "
        "VALUES (?, ?, 'pending', ?, ?, ?)",
        (job_type, json.dumps({'manual': True}), 5, scheduled_at, now_str)
    )
    task_id = cur.lastrowid
    conn.commit()
    conn.close()

    print(f'✅ 已添加任务: #{task_id} {TASK_TYPES[job_type]["name"]}')
    if now_tasks:
        print(f'   ⏰ 立即执行')
    else:
        print(f'   ⏰ 将在下次队列运行时执行')

if __name__ == '__main__':
    main()
