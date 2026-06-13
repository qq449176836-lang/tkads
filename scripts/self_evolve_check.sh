#!/usr/bin/env bash
# ============================================================
# 自进化循环A — 每2小时轻量自检脚本
# v2.0 — 新增进化引擎健康指标 (5项指标 + 告警阈值)
# ============================================================
set -euo pipefail

TKADS_HOME="${HOME}/.tkads"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
TODAY=$(date '+%Y-%m-%d')

echo ""
echo "=== 自进化循环A自检 ==="
echo "时间: ${TIMESTAMP}"
echo ""

# ─── 指标1: E层日志健康（发现率代理指标） ───
OPLOG_DIR="${TKADS_HOME}/operation_log"
if [ -d "${OPLOG_DIR}" ]; then
  TODAY_LOG="${OPLOG_DIR}/${TODAY}.jsonl"
  if [ -f "${TODAY_LOG}" ]; then
    TODAY_COUNT=$(wc -l < "${TODAY_LOG}" 2>/dev/null || echo 0)
    if [ "${TODAY_COUNT}" -ge 3 ]; then
      echo "✅ E层日志: OK（今日${TODAY_COUNT}条记录）"
    else
      echo "⚠️ E层日志: 今日仅${TODAY_COUNT}条记录（建议>=3条/天）"
    fi
  else
    echo "⚠️ E层日志: 今日暂无记录"
  fi
  # 检查上周同期对比（粗略趋势）
  LAST_WEEK=$(date -d '7 days ago' '+%Y-%m-%d' 2>/dev/null || echo "")
  if [ -n "${LAST_WEEK}" ]; then
    LW_LOG="${OPLOG_DIR}/${LAST_WEEK}.jsonl"
    if [ -f "${LW_LOG}" ]; then
      LW_COUNT=$(wc -l < "${LW_LOG}" 2>/dev/null || echo 0)
      echo "  📈 周趋势: 今日${TODAY_COUNT}条 vs 上周同期${LW_COUNT}条"
    fi
  fi
else
  echo "⚠️ E层日志: 目录不存在"
  mkdir -p "${OPLOG_DIR}"
fi

# ─── 指标2: AutoLoader 加载命中率 ───
USAGE_FILE="${TKADS_HOME}/evolution/usage.json"
if [ -f "${USAGE_FILE}" ]; then
  # 检查更新时间
  if [[ "$(uname -s)" == MINGW* ]] || [[ "$(uname -s)" == MSYS* ]]; then
    USAGE_EPOCH=$(date -r "${USAGE_FILE}" +%s 2>/dev/null || echo "0")
  else
    USAGE_EPOCH=$(stat -c %Y "${USAGE_FILE}" 2>/dev/null || stat -f %m "${USAGE_FILE}" 2>/dev/null || echo "0")
  fi
  NOW_EPOCH=$(date +%s)
  DIFF=$(( NOW_EPOCH - USAGE_EPOCH ))
  HOURS_AGO=$(( DIFF / 3600 ))
  
  if [ "${USAGE_EPOCH}" = "0" ]; then
    echo "⚠️ AutoLoader: 无法获取文件时间戳"
  elif [ ${DIFF} -le 86400 ]; then
    echo "✅ AutoLoader: OK（最近更新于${HOURS_AGO}小时前）"
  else
    echo "❌ AutoLoader: 警告（${HOURS_AGO}小时前更新，超过24h）"
  fi

  # 计算加载命中率: auto_load_list 数量 / total skills
  USAGE_PATH_WIN=$(echo "${USAGE_FILE}" | sed 's|^/c/|C:/|; s|^/\([a-z]\)/|\1:/|' 2>/dev/null)
  TOTAL_SKILLS=$(python -c "import json; d=json.load(open(r'${USAGE_PATH_WIN}')); print(len(d.get('skills',{})))" 2>/dev/null || echo "0")
  AUTO_LOAD=$(python -c "import json; d=json.load(open(r'${USAGE_PATH_WIN}')); print(len(d.get('auto_load_list',[])))" 2>/dev/null || echo "0")
  if [ "${TOTAL_SKILLS}" -gt 0 ] && [ "${AUTO_LOAD}" -gt 0 ]; then
    HIT_RATE=$(( AUTO_LOAD * 100 / TOTAL_SKILLS ))
    if [ "${HIT_RATE}" -ge 50 ]; then
      echo "✅ 加载命中率: ${HIT_RATE}% (${AUTO_LOAD}/${TOTAL_SKILLS}) — 健康"
    elif [ "${HIT_RATE}" -ge 30 ]; then
      echo "⚠️ 加载命中率: ${HIT_RATE}% (${AUTO_LOAD}/${TOTAL_SKILLS}) — 偏低"
    else
      echo "❌ 加载命中率: ${HIT_RATE}% (${AUTO_LOAD}/${TOTAL_SKILLS}) — 技能过载"
    fi
  else
    echo "⚠️ 加载命中率: 无法计算"
  fi
else
  echo "❌ AutoLoader: 文件不存在"
fi

# ─── 指标3: 蒸馏成功率（N层笔记增长） ───
NOTES_DIR="${TKADS_HOME}/notes"
NOTE_COUNT=0
if [ -d "${NOTES_DIR}" ]; then
  NOTE_COUNT=$(find "${NOTES_DIR}" -name "*.md" -not -name "README.md" -not -name ".template.md" 2>/dev/null | wc -l)
  # 检查hermes-agent-knowledge子目录
  SUB_NOTE_COUNT=0
  if [ -d "${NOTES_DIR}/hermes-agent-knowledge" ]; then
    SUB_NOTE_COUNT=$(find "${NOTES_DIR}/hermes-agent-knowledge" -name "*.md" -not -name "README.md" 2>/dev/null | wc -l)
  fi
  TOTAL_NOTE_COUNT=$(( NOTE_COUNT + SUB_NOTE_COUNT ))
  echo "✅ N层知识库: ${TOTAL_NOTE_COUNT}篇笔记（主库${NOTE_COUNT} + 外部${SUB_NOTE_COUNT}）"
  
  # 检查今天是否有新笔记（蒸馏活跃度）
  TODAY_NOTES=$(find "${NOTES_DIR}" -name "*.md" -newer "${OPLOG_DIR}/${TODAY}.jsonl" 2>/dev/null | wc -l || echo "0")
  if [ "${TODAY_NOTES}" -gt 0 ]; then
    echo "  📝 今日蒸馏: ${TODAY_NOTES}篇新笔记"
  fi
else
  echo "⚠️ N层知识库: 目录不存在"
fi

# ─── 指标4: 重复错误模式检测（蒸馏成功率代理指标） ───
REPEAT_EVENTS=""
if [ -d "${OPLOG_DIR}" ]; then
  TEMP_FILE=$(mktemp 2>/dev/null || echo "/tmp/tkads_evolve_check.tmp")
  : > "${TEMP_FILE}"
  if [ -f "${TODAY_LOG}" ]; then
    cat "${TODAY_LOG}" >> "${TEMP_FILE}"
  fi
  
  YESTERDAY=$(date -d 'yesterday' '+%Y-%m-%d' 2>/dev/null || date -v-1d '+%Y-%m-%d' 2>/dev/null || echo "")
  if [ -n "${YESTERDAY}" ]; then
    YEST_LOG="${OPLOG_DIR}/${YESTERDAY}.jsonl"
    if [ -f "${YEST_LOG}" ]; then
      cat "${YEST_LOG}" >> "${TEMP_FILE}"
    fi
  fi
  
  TOTAL_LINES=$(wc -l < "${TEMP_FILE}" 2>/dev/null || echo 0)
  if [ "${TOTAL_LINES}" -gt 0 ]; then
    tail -100 "${TEMP_FILE}" 2>/dev/null | grep -oP '"event"\s*:\s*"[^"]*"' | sed 's/"event"\s*:\s*"//;s/"//' | sort | uniq -c | sort -rn | while read count event; do
      if [ "${count}" -ge 2 ]; then
        echo "__REPEAT__ ${count}x ${event}"
      fi
    done > "${TEMP_FILE}.repeats" 2>/dev/null || true
    
    if [ -s "${TEMP_FILE}.repeats" ]; then
      REPEAT_COUNT=$(wc -l < "${TEMP_FILE}.repeats" 2>/dev/null || echo 0)
      EVENTS_LIST=$(cut -d' ' -f3- "${TEMP_FILE}.repeats" 2>/dev/null | tr '\n' ', ' | sed 's/, $//')
      echo "⚠️ 重复错误: 发现${REPEAT_COUNT}个重复模式 → [${EVENTS_LIST}]"
      echo "  🔴 告警: 重复模式 >=3 次应升级到P层"
    else
      echo "✅ 重复错误: 未发现重复模式"
    fi
    rm -f "${TEMP_FILE}.repeats" 2>/dev/null
  else
    echo "✅ 重复错误: 暂无日志记录可分析"
  fi
  rm -f "${TEMP_FILE}" 2>/dev/null
else
  echo "✅ 重复错误: 暂无日志记录可分析"
fi

# ─── 指标5: 技能库增长 ───
SKILLS_DIR="${HOME}/.hermes/skills"
if [ -d "${SKILLS_DIR}" ]; then
  SKILL_COUNT=$(find "${SKILLS_DIR}" -name "SKILL.md" 2>/dev/null | wc -l)
  echo "✅ 技能库: ${SKILL_COUNT}个技能"
  
  # 检查本月新增
  THIS_MONTH=$(date '+%Y-%m')
  NEW_THIS_MONTH=$(find "${SKILLS_DIR}" -name "SKILL.md" -newer "${OPLOG_DIR}/../evolution" 2>/dev/null | wc -l || echo "0")
  echo "  📊 月度增长: 待进化引擎评估"
fi

# ─── 系统资源 ───
if command -v df &>/dev/null; then
  DISK_USAGE=$(df -h "${TKADS_HOME}" 2>/dev/null | tail -1 | awk '{print $(NF-1)}' 2>/dev/null || echo "unknown")
  echo "✅ 系统资源: 磁盘可用空间 (${DISK_USAGE})"
fi

echo ""
echo "=== 自检完成 ==="
echo ""
# 写入E层日志
python "${SCRIPT_DIR}/e_logger.py" --event "self_evolve" --level info --detail "{\"check\":\"cycle_a\",\"e_log_count\":${TODAY_COUNT:-0},\"auto_load_hit_rate\":${HIT_RATE:-0},\"note_count\":${TOTAL_NOTE_COUNT:-0}}" 2>/dev/null || true
