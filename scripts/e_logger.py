#!/usr/bin/env python3
"""
E层日志自动记录脚本
用法: python e_logger.py --event <事件名称> --detail '<JSON字符串>' --level info|warn|error
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone


def main():
    parser = argparse.ArgumentParser(description='E层日志自动记录')
    parser.add_argument('--event', required=True, help='事件名称')
    parser.add_argument('--detail', required=True, help='JSON字符串格式的详细信息')
    parser.add_argument('--level', required=True, choices=['info', 'warn', 'error'], help='日志级别')
    args = parser.parse_args()

    # 验证 detail 是否为有效 JSON
    try:
        detail_obj = json.loads(args.detail)
    except json.JSONDecodeError as e:
        print(f"错误: --detail 参数不是有效的JSON字符串: {e}", file=sys.stderr)
        sys.exit(1)

    # 生成日志目录路径
    home = os.path.expanduser('~')
    log_dir = os.path.join(home, '.tkads', 'operation_log')
    os.makedirs(log_dir, exist_ok=True)

    # 生成以日期命名的日志文件
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    log_file = os.path.join(log_dir, f'{today}.jsonl')

    # 构造日志条目
    log_entry = {
        'timestamp': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z',
        'event': args.event,
        'detail': detail_obj,
        'level': args.level
    }

    # 追加写入日志文件
    with open(log_file, 'a', encoding='utf-8') as f:
        f.write(json.dumps(log_entry, ensure_ascii=False) + '\n')

    print(f"✓ 日志已记录: {log_file}")
    print(f"  事件: {args.event} | 级别: {args.level}")


if __name__ == '__main__':
    main()
