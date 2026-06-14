#!/usr/bin/env python3
"""
collect/queue_runner.py — 统一采集队列调度器

工作流程:
  1. 自动添加今日待采任务到队列（防重复）
  2. 按 priority 顺序依次执行
  3. 失败自动重试（默认2次）
  4. 输出执行报告

用法:
  python3 collect/queue_runner.py                      # 标准执行
  python3 collect/queue_runner.py --type store_health  # 只跑指定类型
  python3 collect/queue_runner.py --dry-run            # 仅查看
"""
import sqlite3, json, os, sys, subprocess, time
from datetime import datetime, date as dt_date
from pathlib import Path

HOME = os.path.expanduser('~').replace('\\', '/')
TKADS = HOME + '/.tkads'
HERMES_SCRIPTS = HOME + '/AppData/Roaming/cn.org.hermesagent.desktop/runtime/hermes-home/scripts'
DB = TKADS + '/data/analytics.db'

# ════════ 任务注册表 ════════
TASK_TYPES = {
    'ads_daily': {
        'name': '广告逐日采集',
        'script': 'collect_ads_daily.js',
        'workdir': HERMES_SCRIPTS,
        'priority': 1,
        'timeout': 300,
        'schedule_time': '06:30',
    },
    'full_rankings': {
        'name': '排名+行业榜单',
        'script': 'collect_full_rankings.js',
        'workdir': HERMES_SCRIPTS,
        'priority': 2,
        'timeout': 600,
        'schedule_time': '06:35',
    },
    'product_analysis': {
        'name': '商品分析采集',
        'script': 'collect_daily_products.js',
        'workdir': HERMES_SCRIPTS,
        'priority': 3,
        'timeout': 300,
        'schedule_time': '06:40',
    },
    'store_health': {
        'name': '店铺健康采集',
        'script': os.path.join(TKADS, 'collect', 'store_health.js'),
        'workdir': TKADS,
        'priority': 5,
        'timeout': 120,
        'schedule_time': '06:45',
        'post_import': True,
        'import_script': os.path.join(TKADS, 'collect', 'store_health_import.py'),
    },
}

# ════════ 数据库工具 ════════
def db_conn():
    return sqlite3.connect(DB)

def check_today_task(job_type, today_str):
    """检查今天是否已有同类型任务"""
    conn = db_conn()
    try:
        cur = conn.execute(
            "SELECT id FROM collect_queue WHERE job_type=? AND scheduled_at LIKE ? AND status NOT IN ('cancelled')",
            (job_type, f"{today_str}%")
        )
        return cur.fetchone() is not None
    finally:
        conn.close()

def insert_queue(job_type, params, priority, scheduled_at, created_at):
    conn = db_conn()
    try:
        conn.execute(
            "INSERT INTO collect_queue (job_type, params, status, priority, scheduled_at, created_at) "
            "VALUES (?, ?, 'pending', ?, ?, ?)",
            (job_type, json.dumps(params), priority, scheduled_at, created_at)
        )
        conn.commit()
    finally:
        conn.close()

def mark_running(task_id, ts):
    conn = db_conn()
    try:
        conn.execute("UPDATE collect_queue SET status='running', started_at=? WHERE id=?", (ts, task_id))
        conn.commit()
    finally:
        conn.close()

def mark_done(task_id, ts, summary):
    conn = db_conn()
    try:
        conn.execute("UPDATE collect_queue SET status='done', completed_at=?, result_json=? WHERE id=?",
                     (ts, summary[:500], task_id))
        conn.commit()
    finally:
        conn.close()

def mark_failed(task_id, ts, error, retry_count):
    conn = db_conn()
    try:
        conn.execute("UPDATE collect_queue SET status='failed', completed_at=?, error_message=?, retry_count=? WHERE id=?",
                     (ts, str(error)[:500], retry_count, task_id))
        conn.commit()
    finally:
        conn.close()

def get_pending():
    conn = db_conn()
    try:
        cur = conn.execute(
            "SELECT id, job_type, params, priority, retry_count, max_retries "
            "FROM collect_queue WHERE status='pending' ORDER BY priority ASC, scheduled_at ASC"
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        conn.close()

def get_report(today_str):
    conn = db_conn()
    try:
        cur = conn.execute(
            "SELECT job_type, status, COUNT(*) as cnt FROM collect_queue "
            "WHERE scheduled_at LIKE ? GROUP BY job_type, status ORDER BY job_type",
            (f"{today_str}%",)
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        conn.close()

# ════════ 执行脚本 ════════
def run_script(script_path, workdir, timeout_sec):
    """运行 Node.js 脚本，返回 (success, stdout, error)"""
    try:
        result = subprocess.run(
            ['node', script_path],
            cwd=workdir,
            capture_output=True,
            text=True,
            timeout=timeout_sec
        )
        if result.returncode == 0:
            return True, result.stdout, None
        else:
            return False, result.stdout, result.stderr or f'exit code {result.returncode}'
    except subprocess.TimeoutExpired:
        return False, '', 'timeout'
    except Exception as e:
        return False, '', str(e)

def run_python(script_path, args=None):
    """运行 Python 脚本"""
    cmd = ['python3', script_path]
    if args:
        cmd.extend(args)
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        return result.returncode == 0, result.stdout, result.stderr
    except Exception as e:
        return False, '', str(e)

# ════════ 主流程 ════════
def main():
    args = sys.argv[1:]
    filter_type = None
    dry_run = False
    if '--type' in args:
        idx = args.index('--type')
        filter_type = args[idx + 1] if idx + 1 < len(args) else None
    if '--dry-run' in args:
        dry_run = True

    today = dt_date.today().isoformat()
    now = datetime.now().isoformat()

    print('=' * 55)
    print(f'📦 采集队列调度器 — {today}')
    if filter_type:
        print(f'   🔍 过滤: {filter_type}')
    if dry_run:
        print('   🏃 干运行模式')
    print('=' * 55)

    # ── 第一步：添加今日任务 ──
    print('\n[1/3] 检查 & 添加今日任务...')
    types_to_check = [filter_type] if filter_type else list(TASK_TYPES.keys())

    for jt in types_to_check:
        cfg = TASK_TYPES.get(jt)
        if not cfg:
            print(f'  ⚠️  未知类型: {jt}')
            continue

        try:
            exists = check_today_task(jt, today)
            if exists:
                print(f'  ⏭️  {cfg["name"]}: 已有今日任务')
                continue
        except Exception as e:
            print(f'  ⚠️  {cfg["name"]}: 查询失败: {e}')

        if dry_run:
            print(f'  📋 {cfg["name"]}: 待添加')
        else:
            try:
                insert_queue(jt, {}, cfg['priority'], f'{today}T{cfg["schedule_time"]}:00', now)
                print(f'  ✅ {cfg["name"]}: 已加入队列')
            except Exception as e:
                print(f'  ❌ {cfg["name"]}: 添加失败: {e}')

    if dry_run:
        print('\n🏃 干运行结束')
        return

    # ── 第二步：处理待办任务 ──
    print('\n[2/3] 处理待办任务...')
    try:
        tasks = get_pending()
    except Exception as e:
        print(f'  ❌ 查询待办失败: {e}')
        return

    if not tasks:
        print('  ✅ 没有待办任务')
    else:
        print(f'  共 {len(tasks)} 个待办任务')

        for i, t in enumerate(tasks):
            cfg = TASK_TYPES.get(t['job_type'])
            if not cfg:
                print(f'  ⚠️  [{i+1}/{len(tasks)}] {t["job_type"]}: 未知类型，跳过')
                try:
                    mark_failed(t['id'], datetime.now().isoformat(), 'unknown job_type', 0)
                except Exception as e:
                    print(f'  ⚠️ 状态更新失败: {e}')
                continue

            print(f'\n  ── [{i+1}/{len(tasks)}] {cfg["name"]} ──')

            # 标记运行中
            try:
                mark_running(t['id'], datetime.now().isoformat())
            except Exception as e:
                print(f'  ⚠️ 状态标记失败: {e}')

            script_path = cfg['script']
            workdir = cfg['workdir']
            max_retries = t.get('max_retries', 2)
            success = False
            output = ''
            error_msg = ''
            retries_used = 0

            # 执行（含重试）
            for retry in range(max_retries + 1):
                if retry > 0:
                    print(f'    🔄 第 {retry} 次重试...')
                    time.sleep(5)

                ok, out, err = run_script(script_path, workdir, cfg['timeout'])
                output = out
                error_msg = err
                retries_used = retry

                if ok and err is None:
                    success = True
                    break

                if err == 'timeout':
                    break  # 超时不重试

            if success:
                print(f'    ✅ 采集成功')

                # 提取输出摘要（最后5行非空）
                lines = [l.strip() for l in output.split('\n') if l.strip()]
                summary = ' | '.join(lines[-5:])[:500]

                try:
                    mark_done(t['id'], datetime.now().isoformat(), summary)
                except Exception as e:
                    print(f'    ⚠️ 状态更新失败: {e}')

                # store_health 额外入库
                if cfg.get('post_import'):
                    print(f'    🗄️  入库中...')
                    data_dir = os.path.join(TKADS, 'data')
                    health_files = [f for f in os.listdir(data_dir) if f.startswith('store_health_') and f.endswith('.json')]
                    health_files.sort(reverse=True)
                    if health_files:
                        json_file = os.path.join(data_dir, health_files[0])
                        import_script = cfg['import_script']
                        ok, out, err = run_python(import_script, [json_file])
                        if ok:
                            print(f'    ✅ 入库成功')
                        else:
                            print(f'    ❌ 入库失败: {err or out}')
                    else:
                        print(f'    ⚠️ 未找到 store_health JSON 文件')

            else:
                print(f'    ❌ 采集失败: {error_msg or "unknown"}')
                try:
                    mark_failed(t['id'], datetime.now().isoformat(), error_msg or 'unknown', retries_used)
                except Exception as e:
                    print(f'    ⚠️ 状态更新失败: {e}')

            # 任务间等待
            if i < len(tasks) - 1:
                print('    ⏳ 等待 10 秒...')
                time.sleep(10)

    # ── 第三步：输出汇总 ──
    print('\n[3/3] 执行报告')
    try:
        report = get_report(today)
        if report:
            print(f'  {"类型".ljust(20)} {"状态".ljust(10)} 数量')
            print(f'  {"-" * 40}')
            for r in report:
                type_name = (TASK_TYPES.get(r['job_type'], {}).get('name', r['job_type'])).ljust(20)
                print(f'  {type_name} {r["status"].ljust(10)} {r["cnt"]}')
    except Exception as e:
        print(f'  ⚠️ 报告生成失败: {e}')

    print('\n✅ 队列处理完成')

if __name__ == '__main__':
    main()
