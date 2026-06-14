#!/usr/bin/env python3
"""SQL查询工具 - 辅助queue_runner执行数据库操作"""
import sqlite3, json, sys, os

DB = os.path.expanduser('~/.tkads/data/analytics.db')

def main():
    if len(sys.argv) < 2:
        print('USAGE: python3 sql_helper.py <action> [args...]')
        print('  actions: insert_queue | update_queue | query_queue | query_report')
        sys.exit(1)

    action = sys.argv[1]
    conn = sqlite3.connect(DB)
    cur = conn.cursor()

    try:
        if action == 'insert_queue':
            # args: job_type params priority scheduled_at created_at
            cur.execute(
                "INSERT INTO collect_queue (job_type, params, status, priority, scheduled_at, created_at) VALUES (?, ?, 'pending', ?, ?, ?)",
                (sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5], sys.argv[6])
            )
            conn.commit()
            print('OK')

        elif action == 'update_queue':
            # args: id field value
            cur.execute(f"UPDATE collect_queue SET {sys.argv[3]}=? WHERE id=?", (sys.argv[4], int(sys.argv[2])))
            conn.commit()
            print('OK')

        elif action == 'check_today':
            # args: job_type today_str
            cur.execute(
                "SELECT id FROM collect_queue WHERE job_type=? AND scheduled_at LIKE ? AND status NOT IN ('cancelled')",
                (sys.argv[2], f"{sys.argv[3]}%")
            )
            rows = cur.fetchall()
            print(json.dumps([r[0] for r in rows]))

        elif action == 'pending_tasks':
            # 获取待办任务
            cur.execute(
                "SELECT id, job_type, params, priority, retry_count, max_retries "
                "FROM collect_queue WHERE status='pending' ORDER BY priority ASC, scheduled_at ASC"
            )
            rows = cur.fetchall()
            cols = [d[0] for d in cur.description]
            print(json.dumps([dict(zip(cols, r)) for r in rows]))

        elif action == 'today_report':
            # args: today_str
            cur.execute(
                "SELECT job_type, status, COUNT(*) as cnt FROM collect_queue "
                "WHERE scheduled_at LIKE ? GROUP BY job_type, status ORDER BY job_type",
                (f"{sys.argv[2]}%",)
            )
            rows = cur.fetchall()
            cols = [d[0] for d in cur.description]
            print(json.dumps([dict(zip(cols, r)) for r in rows]))

        elif action == 'mark_start':
            # args: id timestamp
            cur.execute(
                "UPDATE collect_queue SET status='running', started_at=? WHERE id=?",
                (sys.argv[3], int(sys.argv[2]))
            )
            conn.commit()
            print('OK')

        elif action == 'mark_done':
            # args: id timestamp summary
            cur.execute(
                "UPDATE collect_queue SET status='done', completed_at=?, result_json=? WHERE id=?",
                (sys.argv[3], sys.argv[4], int(sys.argv[2]))
            )
            conn.commit()
            print('OK')

        elif action == 'mark_failed':
            # args: id timestamp error retry_count
            cur.execute(
                "UPDATE collect_queue SET status='failed', completed_at=?, error_message=?, retry_count=? WHERE id=?",
                (sys.argv[3], sys.argv[4], int(sys.argv[5]), int(sys.argv[2]))
            )
            conn.commit()
            print('OK')

        else:
            print(f'ERR: unknown action {action}')

    except Exception as e:
        print(f'ERR: {e}')
        sys.exit(1)
    finally:
        conn.close()

if __name__ == '__main__':
    main()
