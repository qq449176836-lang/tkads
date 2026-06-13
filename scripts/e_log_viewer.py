#!/usr/bin/env python3
"""
E层日志查看脚本
用法:
  python e_log_viewer.py --today             查看今天日志
  python e_log_viewer.py --date 2026-06-13   查看指定日期
  python e_log_viewer.py --search "关键词"    搜索日志
  python e_log_viewer.py --stats             显示统计
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from collections import Counter


def get_log_dir():
    home = os.path.expanduser('~')
    return os.path.join(home, '.tkads', 'operation_log')


def read_log_file(filepath):
    """读取单个jsonl文件，返回解析后的行列表"""
    entries = []
    if not os.path.exists(filepath):
        return entries
    with open(filepath, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    print(f"  警告: 无法解析行: {line[:80]}...", file=sys.stderr)
    return entries


def print_table(entries, show_detail=True):
    """以美观表格形式输出日志"""
    if not entries:
        print("  没有找到匹配的日志条目。")
        return

    # 计算各列宽度
    col_widths = {'ts': 24, 'level': 6, 'event': 40, 'detail': 50}
    for e in entries:
        col_widths['ts'] = max(col_widths['ts'], len(e.get('timestamp', '')))
        col_widths['level'] = max(col_widths['level'], len(e.get('level', '')))
        col_widths['event'] = max(col_widths['event'], len(e.get('event', '')))
        detail_str = json.dumps(e.get('detail', {}), ensure_ascii=False)
        col_widths['detail'] = max(col_widths['detail'], min(len(detail_str), 80))

    # 确保最小宽度
    for k in col_widths:
        col_widths[k] = max(col_widths[k], len(k) + 2)

    sep = '+' + '-' * (col_widths['ts'] + 2) + '+' + '-' * (col_widths['level'] + 2) + '+' + '-' * (col_widths['event'] + 2) + '+' + '-' * (col_widths['detail'] + 2) + '+'

    # 表头
    print(sep)
    header = f"| {'时间'.ljust(col_widths['ts'])} | {'级别'.ljust(col_widths['level'])} | {'事件'.ljust(col_widths['event'])} | {'详细信息'.ljust(col_widths['detail'])} |"
    print(header)
    print(sep)

    # 数据行
    for e in entries:
        ts = e.get('timestamp', '')
        level = e.get('level', '').upper()
        event = e.get('event', '')
        detail_str = json.dumps(e.get('detail', {}), ensure_ascii=False)
        if len(detail_str) > col_widths['detail']:
            detail_str = detail_str[:col_widths['detail'] - 3] + '...'
        row = f"| {ts.ljust(col_widths['ts'])} | {level.center(col_widths['level'])} | {event.ljust(col_widths['event'])} | {detail_str.ljust(col_widths['detail'])} |"
        print(row)

    print(sep)
    print(f"  共 {len(entries)} 条日志")


def cmd_today():
    log_dir = get_log_dir()
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    filepath = os.path.join(log_dir, f'{today}.jsonl')
    entries = read_log_file(filepath)
    print(f"\n📋 今天 ({today}) 的日志:\n")
    print_table(entries)


def cmd_date(date_str):
    log_dir = get_log_dir()
    filepath = os.path.join(log_dir, f'{date_str}.jsonl')
    if not os.path.exists(filepath):
        print(f"❌ 没有找到 {date_str} 的日志文件")
        return
    entries = read_log_file(filepath)
    print(f"\n📋 {date_str} 的日志:\n")
    print_table(entries)


def cmd_search(keyword):
    log_dir = get_log_dir()
    all_entries = []
    print(f"\n🔍 搜索关键词: \"{keyword}\"\n")

    if not os.path.isdir(log_dir):
        print("  日志目录不存在。")
        return

    for fname in sorted(os.listdir(log_dir)):
        if fname.endswith('.jsonl'):
            filepath = os.path.join(log_dir, fname)
            entries = read_log_file(filepath)
            for e in entries:
                # 搜索 event 和 detail 字段
                if keyword.lower() in e.get('event', '').lower() or \
                   keyword.lower() in json.dumps(e.get('detail', {}), ensure_ascii=False).lower():
                    all_entries.append(e)

    if all_entries:
        print_table(all_entries)
    else:
        print("  没有找到匹配的日志条目。")


def cmd_stats():
    log_dir = get_log_dir()
    level_counter = Counter()
    event_counter = Counter()
    total = 0

    if not os.path.isdir(log_dir):
        print("  日志目录不存在。")
        return

    for fname in sorted(os.listdir(log_dir)):
        if fname.endswith('.jsonl'):
            filepath = os.path.join(log_dir, fname)
            entries = read_log_file(filepath)
            total += len(entries)
            for e in entries:
                level_counter[e.get('level', 'unknown')] += 1
                event_counter[e.get('event', 'unknown')] += 1

    print(f"\n📊 日志统计\n")
    print(f"  总日志条数: {total}")
    print()
    print(f"  📈 按级别统计:")
    for level in ['info', 'warn', 'error']:
        cnt = level_counter.get(level, 0)
        bar = '█' * min(cnt, 40) + ('░' * max(0, 40 - min(cnt, 40)) if cnt == 0 else '')
        print(f"    {level.upper():<6}: {cnt:>3} 条 {bar}")

    print()
    print(f"  📈 按事件统计 (TOP 10):")
    for event, cnt in event_counter.most_common(10):
        print(f"    {event:<40}: {cnt:>3} 条")


def main():
    parser = argparse.ArgumentParser(description='E层日志查看器')
    parser.add_argument('--today', action='store_true', help='查看今天日志')
    parser.add_argument('--date', type=str, help='查看指定日期 (格式: YYYY-MM-DD)')
    parser.add_argument('--search', type=str, help='搜索日志关键词')
    parser.add_argument('--stats', action='store_true', help='显示日志统计')

    args = parser.parse_args()

    # 如果没有参数，显示帮助
    if len(sys.argv) == 1:
        parser.print_help()
        sys.exit(0)

    if args.today:
        cmd_today()
    elif args.date:
        cmd_date(args.date)
    elif args.search:
        cmd_search(args.search)
    elif args.stats:
        cmd_stats()
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
