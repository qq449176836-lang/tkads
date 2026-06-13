#!/usr/bin/env bash
# ============================================================
# 沉淀铁律钩子 — 任务结束后写入E层
# 用法: bash precipitate_hook.sh --event "事件名" --level "info|warn|error" --detail "描述"
# ============================================================
set -euo pipefail

TKADS_HOME="${HOME}/.tkads"
E_LOGGER="${TKADS_HOME}/scripts/e_logger.py"
OPLOG_DIR="${TKADS_HOME}/operation_log"

# ─── 解析参数 ───
EVENT=""
LEVEL="info"
DETAIL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --event)
      EVENT="$2"
      shift 2
      ;;
    --level)
      LEVEL="$2"
      shift 2
      ;;
    --detail)
      DETAIL="$2"
      shift 2
      ;;
    *)
      echo "❌ 未知参数: $1"
      echo "用法: bash precipitate_hook.sh --event \"事件名\" --level \"info|warn|error\" --detail \"描述\""
      exit 1
      ;;
  esac
done

# ─── 验证参数 ───
if [ -z "${EVENT}" ]; then
  echo "❌ 错误: --event 是必填参数"
  exit 1
fi

if [[ ! "${LEVEL}" =~ ^(info|warn|error)$ ]]; then
  echo "⚠️ 警告: --level 应为 info|warn|error，使用默认值 info"
  LEVEL="info"
fi

# ─── 写入E层 ───
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
TODAY=$(date '+%Y-%m-%d')

# 确保 operation_log 目录存在
mkdir -p "${OPLOG_DIR}"

ENTRY=$(cat <<EOF
{"timestamp": "${TIMESTAMP}", "event": "${EVENT}", "level": "${LEVEL}", "detail": "${DETAIL}"}
EOF
)

if [ -f "${E_LOGGER}" ]; then
  # 使用 e_logger.py 写入
  echo "📝 使用 e_logger.py 写入E层..."
  python3 "${E_LOGGER}" --event "${EVENT}" --level "${LEVEL}" --detail "${DETAIL}" 2>&1 || {
    echo "⚠️ e_logger.py 失败，直接写入文件..."
    echo "${ENTRY}" >> "${OPLOG_DIR}/${TODAY}.jsonl"
  }
else
  # 直接写入 JSONL
  echo "📝 直接写入 ${OPLOG_DIR}/${TODAY}.jsonl ..."
  echo "${ENTRY}" >> "${OPLOG_DIR}/${TODAY}.jsonl"
fi

# ─── 输出结果 ───
echo ""
echo "=== 沉淀铁律钩子 ==="
echo "时间: ${TIMESTAMP}"
echo "事件: ${EVENT}"
echo "级别: ${LEVEL}"
echo "详情: ${DETAIL}"
echo "写入: ${OPLOG_DIR}/${TODAY}.jsonl"
echo "状态: ✅ 已记录"
echo ""
