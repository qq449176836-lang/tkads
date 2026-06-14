#!/usr/bin/env python3
"""将店铺健康JSON数据入库到store_health_daily表"""
import sqlite3, json, sys, os

DB = os.path.expanduser('~/.tkads/data/analytics.db')

def main():
    if len(sys.argv) < 2:
        print("用法: python3 store_health_import.py <json_file>")
        sys.exit(1)

    with open(sys.argv[1]) as f:
        data = json.load(f)

    date = data.get('date', '')
    if not date:
        print("JSON中缺少date字段")
        sys.exit(1)

    conn = sqlite3.connect(DB)
    cur = conn.cursor()

    # 检查是否已存在
    cur.execute("SELECT id FROM store_health_daily WHERE collect_date = ?", (date,))
    existing = cur.fetchone()

    if existing:
        if data.get('force'):
            cur.execute("DELETE FROM store_health_daily WHERE collect_date = ?", (date,))
            print(f"  ⚠️  覆盖已有 {date} 数据")
        else:
            print(f"  ⏭️  {date} 已有数据，跳过")
            conn.close()
            return

    cols = [
        'collect_date', 'violation_score', 'risk_level', 'has_new_violation',
        'unread_violation_number', 'policy_compliance_count', 'policy_compliance_score',
        'order_fulfillment_count', 'order_fulfillment_score', 'service_metrics_count',
        'service_metrics_score', 'critical_count', 'critical_score',
        'next_day_delivery_rate', 'fast_dispatch_rate', 'late_dispatch_rate',
        'seller_cancellation_rate', 'instant_late_dispatch_rate', 'same_day_late_dispatch_rate',
        'negative_review_rate', 'service_negative_review_rate', 'seller_fault_rr_rate',
        'response_rate_12h', 'avg_response_time_hours', 'chat_satisfaction_rate',
        'shop_limited', 'today_order_count', 'raw_violation', 'raw_performance', 'raw_shop_limit'
    ]
    vals = [
        date,
        data.get('violation_score'),
        data.get('risk_level'),
        1 if data.get('has_new_violation') else 0,
        data.get('unread_violation_number'),
        data.get('policy_compliance_count'),
        data.get('policy_compliance_score'),
        data.get('order_fulfillment_count'),
        data.get('order_fulfillment_score'),
        data.get('service_metrics_count'),
        data.get('service_metrics_score'),
        data.get('critical_count'),
        data.get('critical_score'),
        data.get('next_day_delivery_rate'),
        data.get('fast_dispatch_rate'),
        data.get('late_dispatch_rate'),
        data.get('seller_cancellation_rate'),
        data.get('instant_late_dispatch_rate'),
        data.get('same_day_late_dispatch_rate'),
        data.get('negative_review_rate'),
        data.get('service_negative_review_rate'),
        data.get('seller_fault_rr_rate'),
        data.get('response_rate_12h'),
        data.get('avg_response_time_hours'),
        data.get('chat_satisfaction_rate'),
        1 if data.get('shop_limited') else 0,
        data.get('today_order_count'),
        json.dumps(data.get('raw_violation', {}), ensure_ascii=False),
        json.dumps(data.get('raw_performance', {}), ensure_ascii=False),
        json.dumps(data.get('raw_shop_limit', {}), ensure_ascii=False),
    ]

    placeholders = ','.join(['?'] * len(cols))
    cur.execute(f"INSERT INTO store_health_daily ({','.join(cols)}) VALUES ({placeholders})", vals)
    conn.commit()
    conn.close()
    print(f"  ✅ {date} 店铺健康数据入库成功")

if __name__ == '__main__':
    main()
