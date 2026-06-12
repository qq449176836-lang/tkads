#!/bin/bash
# Hermes 健康监控 (bash 版 — 无需 Python)
# 每分钟运行一次，仅在状态变化时报告

RUNTIME="~//AppData/Roaming/cn.org.hermesagent.desktop/runtime"
STATE_FILE="$RUNTIME/gateway-runtime/health_state.txt"

# 检查项
checks() {
    ISSUES=""
    
    # 1. Gateway 进程
    PID=$(grep -o '"pid":[[:space:]]*[0-9]*' "$RUNTIME/gateway-runtime/gateway.pid" 2>/dev/null | grep -o '[0-9]*$')
    if [ -z "$PID" ]; then
        ISSUES="$ISSUES\n[P0] 无法读取 Gateway PID"
    elif ! tasklist 2>/dev/null | awk '{print $2}' | grep -qx "$PID"; then
        ISSUES="$ISSUES\n[P0] Gateway 进程已死！PID=$PID"
    fi
    
    # 2. 锁文件僵尸
    if [ -n "$PID" ]; then
        ALIVE=$(tasklist 2>/dev/null | awk '{print $2}' | grep -xc "$PID" || echo 0)
        if [ "$ALIVE" -eq 0 ]; then
            LOCK_COUNT=$(find "$RUNTIME/gateway-runtime" -name "*.lock" 2>/dev/null | wc -l)
            if [ "$LOCK_COUNT" -gt 0 ]; then
                ISSUES="$ISSUES\n[P1] $LOCK_COUNT 个僵尸锁文件（进程已死）"
            fi
        fi
    fi
    
    # 3. 磁盘
    DISK=$(df /c/ 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%')
    if [ "$DISK" -gt 85 ]; then
        ISSUES="$ISSUES\n[P2] 磁盘使用率 ${DISK}%"
    fi
    
    echo -e "$ISSUES"
}

NEW=$(checks | md5sum 2>/dev/null | cut -d' ' -f1 || checks | cksum 2>/dev/null | cut -d' ' -f1)
OLD=$(cat "$STATE_FILE" 2>/dev/null)

if [ "$NEW" != "$OLD" ] || [ ! -f "$STATE_FILE" ]; then
    echo "$NEW" > "$STATE_FILE"
    ISSUES=$(checks)
    if [ -n "$ISSUES" ]; then
        echo -e "🏥 Hermes 健康告警\n$ISSUES"
    else
        echo "✅ Hermes 健康: 一切正常"
    fi
fi
