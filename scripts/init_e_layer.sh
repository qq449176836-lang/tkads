#!/usr/bin/env bash
# E层日志系统初始化脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TKADS_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$TKADS_DIR/operation_log"

echo "🚀 开始初始化 E层日志系统..."

# 创建 operation_log 目录
mkdir -p "$LOG_DIR"
echo "✓ 创建日志目录: $LOG_DIR"

# 获取今天的日期
TODAY=$(date +%Y-%m-%d)
LOG_FILE="$LOG_DIR/$TODAY.jsonl"

# 写入第一条示例日志
python3 "$SCRIPT_DIR/e_logger.py" \
  --event "E层系统初始化" \
  --detail '{"action": "system_init", "message": "E层日志系统初始化完成"}' \
  --level info 2>/dev/null || \
python "$SCRIPT_DIR/e_logger.py" \
  --event "E层系统初始化" \
  --detail '{"action": "system_init", "message": "E层日志系统初始化完成"}' \
  --level info

echo ""
echo "✅ E层日志系统初始化完成"
echo "   日志目录: $LOG_DIR"
echo "   当前日志: $LOG_FILE"
