#!/usr/bin/env python3
"""建 collect_queue + store_health_daily 表"""
import sqlite3, os

DB = os.path.expanduser('~/.tkads/data/analytics.db')
conn = sqlite3.connect(DB)
cur = conn.cursor()

# ── 1. 采集队列表 ──
cur.execute("""
CREATE TABLE IF NOT EXISTS collect_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,
  params TEXT,
  status TEXT DEFAULT 'pending',
  priority INTEGER DEFAULT 0,
  scheduled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 2,
  result_json TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
)
""")

# 索引
cur.execute("CREATE INDEX IF NOT EXISTS idx_cq_status ON collect_queue(status)")
cur.execute("CREATE INDEX IF NOT EXISTS idx_cq_type ON collect_queue(job_type)")
cur.execute("CREATE INDEX IF NOT EXISTS idx_cq_sched ON collect_queue(scheduled_at)")

# ── 2. 店铺健康逐日表 ──
cur.execute("""
CREATE TABLE IF NOT EXISTS store_health_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collect_date TEXT NOT NULL UNIQUE,
  
  -- 违规总览
  violation_score INTEGER,
  risk_level TEXT,
  has_new_violation INTEGER,
  unread_violation_number INTEGER,
  policy_compliance_count INTEGER,
  policy_compliance_score INTEGER,
  order_fulfillment_count INTEGER,
  order_fulfillment_score INTEGER,
  service_metrics_count INTEGER,
  service_metrics_score INTEGER,
  critical_count INTEGER,
  critical_score INTEGER,
  
  -- 表现指标
  next_day_delivery_rate REAL,
  fast_dispatch_rate REAL,
  late_dispatch_rate REAL,
  seller_cancellation_rate REAL,
  instant_late_dispatch_rate REAL,
  same_day_late_dispatch_rate REAL,
  negative_review_rate REAL,
  service_negative_review_rate REAL,
  seller_fault_rr_rate REAL,
  response_rate_12h REAL,
  avg_response_time_hours REAL,
  chat_satisfaction_rate REAL,
  
  -- 店铺限制
  shop_limited INTEGER,
  today_order_count INTEGER,
  
  -- 原始数据备份
  raw_violation TEXT,
  raw_performance TEXT,
  raw_shop_limit TEXT,
  
  created_at TEXT DEFAULT (datetime('now','localtime'))
)
""")

conn.commit()
conn.close()
print("✅ 表已创建: collect_queue, store_health_daily")
