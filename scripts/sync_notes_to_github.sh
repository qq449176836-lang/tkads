#!/usr/bin/env bash
# 每日导出脚本 — 检查笔记和日志目录是否有更新

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TKADS_DIR="$(dirname "$SCRIPT_DIR")"

NOTES_DIR="$TKADS_DIR/notes"
LOG_DIR="$TKADS_DIR/operation_log"

HAS_UPDATES=false

echo "🔍 检查知识库更新状态..."
echo ""

# 检查 notes 目录
if [ -d "$NOTES_DIR" ]; then
    echo "  📝 笔记目录: $NOTES_DIR"
    NOTE_COUNT=$(find "$NOTES_DIR" -maxdepth 1 -name "*.md" ! -name ".template.md" | wc -l)
    echo "     笔记数量: $NOTE_COUNT 篇"
    # 检查最近修改的文件（24小时内）
    RECENT_NOTES=$(find "$NOTES_DIR" -name "*.md" -mtime -1 2>/dev/null | wc -l)
    if [ "$RECENT_NOTES" -gt 0 ]; then
        echo "     最近24小时有 $RECENT_NOTES 篇笔记更新 ✓"
        HAS_UPDATES=true
    else
        echo "     最近24小时无更新"
    fi
else
    echo "  ⚠️  笔记目录不存在: $NOTES_DIR"
fi

echo ""

# 检查 operation_log 目录
if [ -d "$LOG_DIR" ]; then
    echo "  📋 日志目录: $LOG_DIR"
    LOG_COUNT=$(find "$LOG_DIR" -name "*.jsonl" | wc -l)
    echo "     日志文件数: $LOG_COUNT 天"
    RECENT_LOGS=$(find "$LOG_DIR" -name "*.jsonl" -mtime -1 2>/dev/null | wc -l)
    if [ "$RECENT_LOGS" -gt 0 ]; then
        echo "     最近24小时有 $RECENT_LOGS 个日志文件更新 ✓"
        HAS_UPDATES=true
    else
        echo "     最近24小时无更新"
    fi
else
    echo "  ⚠️  日志目录不存在: $LOG_DIR"
fi

echo ""

if [ "$HAS_UPDATES" = true ]; then
    echo "✅ 检测到更新内容，准备同步到GitHub"
    echo "   提示: 如需实际同步，请配置Git仓库并执行:"
    echo "     cd $TKADS_DIR && git add . && git commit -m 'auto sync' && git push"
else
    echo "ℹ️  没有检测到新更新，无需同步"
fi
