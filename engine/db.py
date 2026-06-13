"""
tkads - 数据库层
SQLite 存储：广告快照、产品/店铺映射、时区映射、操作日志
"""
import sqlite3
import os
import json
from datetime import datetime

DB_PATH = os.path.expanduser('~/.tkads/data/ads.db')

def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn

def init_db():
    with get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS campaign_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_id TEXT NOT NULL,
                snapshot_date TEXT NOT NULL DEFAULT (date('now')),
                snapshot_time TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                campaign_name TEXT,
                status TEXT,
                budget REAL DEFAULT 0,
                roi_target REAL DEFAULT 0,
                cost REAL DEFAULT 0,
                orders INTEGER DEFAULT 0,
                revenue REAL DEFAULT 0,
                roi REAL DEFAULT 0,
                product_id TEXT DEFAULT '',
                shop_id TEXT DEFAULT '',
                raw_data TEXT,
                UNIQUE(campaign_id, snapshot_date)
            );

            CREATE TABLE IF NOT EXISTS products (
                spu_id TEXT PRIMARY KEY,
                campaign_id TEXT,
                product_name TEXT,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS tz_mappings (
                campaign_id TEXT PRIMARY KEY,
                ad_id TEXT,
                custom_tz_id TEXT NOT NULL,
                custom_tz_type INTEGER DEFAULT 1,
                tz_name TEXT,
                start_time TEXT,
                spu_id TEXT DEFAULT '',
                roi_target REAL DEFAULT 0,
                budget REAL DEFAULT 0,
                captured_at TEXT DEFAULT (datetime('now','localtime'))
            );

            -- 为已有数据补充 ad_id 列（如果不存在）
            CREATE TABLE IF NOT EXISTS campaign_meta (
                campaign_id TEXT PRIMARY KEY,
                ad_id TEXT,
                start_time TEXT,
                custom_tz_id TEXT,
                custom_tz_type INTEGER DEFAULT 1,
                spu_id TEXT DEFAULT '',
                product_name TEXT,
                roi_target REAL DEFAULT 0,
                budget REAL DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS operation_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                action_type TEXT NOT NULL,
                campaign_id TEXT,
                params TEXT,
                result TEXT,
                notes TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_snapshots_campaign ON campaign_snapshots(campaign_id, snapshot_date);
            CREATE INDEX IF NOT EXISTS idx_ops_campaign ON operation_logs(campaign_id);
            CREATE INDEX IF NOT EXISTS idx_ops_time ON operation_logs(timestamp);
        """)

def log_operation(action_type, campaign_id=None, params=None, result=None, notes=None):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO operation_logs (action_type, campaign_id, params, result, notes) VALUES (?, ?, ?, ?, ?)",
            [action_type, campaign_id,
             json.dumps(params) if params else None,
             json.dumps(result) if result else None,
             notes]
        )

def save_snapshot(campaign_id, name, status, budget=0, roi_target=0, cost=0, product_id='', shop_id='', raw_data=None):
    with get_conn() as conn:
        conn.execute("""
            INSERT OR REPLACE INTO campaign_snapshots 
            (campaign_id, snapshot_date, snapshot_time, campaign_name, status, budget, roi_target, cost, product_id, shop_id, raw_data)
            VALUES (?, date('now'), datetime('now','localtime'), ?, ?, ?, ?, ?, ?, ?, ?)
        """, [campaign_id, name, status, budget, roi_target, cost, product_id, shop_id,
              json.dumps(raw_data) if raw_data else None])

def save_tz_mapping(campaign_id, custom_tz_id, tz_name=None, tz_type=1, start_time=None):
    with get_conn() as conn:
        if start_time:
            conn.execute("""
                INSERT OR REPLACE INTO tz_mappings (campaign_id, custom_tz_id, custom_tz_type, tz_name, start_time)
                VALUES (?, ?, ?, ?, ?)
            """, [campaign_id, custom_tz_id, tz_type, tz_name, start_time])
        else:
            conn.execute("""
                INSERT OR REPLACE INTO tz_mappings (campaign_id, custom_tz_id, custom_tz_type, tz_name)
                VALUES (?, ?, ?, ?)
            """, [campaign_id, custom_tz_id, tz_type, tz_name])

def get_tz_id(campaign_id):
    """返回 (custom_tz_id, custom_tz_type, start_time) 或 None"""
    with get_conn() as conn:
        row = conn.execute("SELECT custom_tz_id, custom_tz_type, start_time FROM tz_mappings WHERE campaign_id=?", [campaign_id]).fetchone()
        if row:
            return (row['custom_tz_id'], row['custom_tz_type'], row.get('start_time'))
        return None

def get_latest_snapshots():
    """获取所有广告的最新快照"""
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT s.* FROM campaign_snapshots s
            INNER JOIN (
                SELECT campaign_id, MAX(snapshot_date) as max_date
                FROM campaign_snapshots GROUP BY campaign_id
            ) latest ON s.campaign_id = latest.campaign_id AND s.snapshot_date = latest.max_date
            ORDER BY s.cost DESC
        """).fetchall()
        return [dict(r) for r in rows]

def get_recent_ops(hours=48):
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT * FROM operation_logs 
            WHERE timestamp >= datetime('now', '-{} hours', 'localtime')
            ORDER BY timestamp DESC
        """.format(hours)).fetchall()
        return [dict(r) for r in rows]

def get_all_campaign_ids():
    with get_conn() as conn:
        rows = conn.execute("SELECT DISTINCT campaign_id FROM campaign_snapshots").fetchall()
        return [r['campaign_id'] for r in rows]

def save_campaign_meta(campaign_id, ad_id=None, start_time=None, custom_tz_id=None, 
                       custom_tz_type=1, spu_id='', product_name='', roi_target=0, budget=0):
    """保存广告创建时的完整元数据（ad_id, start_time, 等）"""
    with get_conn() as conn:
        conn.execute("""INSERT OR REPLACE INTO campaign_meta 
            (campaign_id, ad_id, start_time, custom_tz_id, custom_tz_type, spu_id, product_name, roi_target, budget)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, [campaign_id, ad_id, start_time, custom_tz_id, custom_tz_type, spu_id, product_name, roi_target, budget])
        # 使用同一连接记录操作日志，避免锁冲突
        conn.execute(
            "INSERT INTO operation_logs (action_type, campaign_id, params, notes) VALUES (?, ?, ?, ?)",
            ['save_meta', campaign_id,
             json.dumps({'ad_id': ad_id, 'start_time': start_time, 'spu_id': spu_id}),
             None])

def get_campaign_meta(campaign_id):
    """获取广告创建元数据，返回 dict 或 None"""
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM campaign_meta WHERE campaign_id=?", [campaign_id]).fetchone()
        if row:
            return dict(row)
        return None

def get_all_meta():
    """获取所有广告元数据"""
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM campaign_meta ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]

def has_ad_id(campaign_id):
    """检查广告是否有 ad_id"""
    with get_conn() as conn:
        row = conn.execute("SELECT ad_id FROM campaign_meta WHERE campaign_id=? AND ad_id IS NOT NULL AND ad_id!=''", [campaign_id]).fetchone()
        return row is not None and bool(row['ad_id'])

def update_snapshot_products(campaign_id, product_id, shop_id):
    """更新已有快照的产品/店铺信息"""
    with get_conn() as conn:
        conn.execute("""
            UPDATE campaign_snapshots SET product_id=?, shop_id=?
            WHERE campaign_id=? AND snapshot_date=date('now')
        """, [product_id, shop_id, campaign_id])

# 初始化
init_db()
