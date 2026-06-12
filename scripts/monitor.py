#!/usr/bin/env python3
"""
Monitor v2 — 全能守护者
分级告警 + 探针检测 + 自动恢复 + 去重通知
"""
import json, os, subprocess, sqlite3, time, urllib.request
from datetime import datetime, timedelta

# ═══ 配置 ═══
HOME = os.path.expanduser("~")
STATE_FILE = os.path.join(HOME, ".hermes", "scripts", ".monitor_state.json")
LOG_FILE = os.path.join(HOME, ".hermes", "scripts", ".monitor_log.jsonl")
DB_PATH = os.path.join(HOME, ".tkads", "data", "analytics.db")
HERMES_EXE = os.path.join(
    os.environ.get('APPDATA', ''),
    'cn.org.hermesagent.desktop', 'runtime', 'versions', '0.16.0-cn.6',
    'hermes-agent-cn-runtime-win32-x64.exe'
)
ADS_API = "http://local.adspower.net:50325"
ADS_PROFILE = "k1456ta2"
FEISHU_WEBHOOK = None
WEBHOOK_PATH = os.path.join(HOME, ".hermes", "scripts", ".report_webhook")
if os.path.exists(WEBHOOK_PATH):
    with open(WEBHOOK_PATH) as f:
        FEISHU_WEBHOOK = f.read().strip()

CRON_JOBS = {
    'daily-collect':       {'schedule': '0 7 * * *'},
    'daily-github-backup': {'schedule': '0 11 * * *'},
    'daily-ad-report':     {'schedule': '0 9 * * *'},
    'daily-creator-report':{'schedule': '0 9 * * *'},
    'cron-guardian':       {'schedule': 'every 120m'},
}

# ═══ 状态管理 ═══
def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"checks": {}, "last_p0": None, "last_p1": None, "recovery_count": 0}

def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)

def log_event(level, check, msg, recovered=False):
    entry = json.dumps({
        "time": datetime.now().isoformat(),
        "level": level,
        "check": check,
        "msg": msg,
        "recovered": recovered
    })
    with open(LOG_FILE, 'a') as f:
        f.write(entry + "\n")

# ═══ 通知 ═══
def notify(level, title, body):
    if not FEISHU_WEBHOOK:
        print(f"[{level}] {title}: {body}")
        return
    # P0/1 用醒目格式
    emoji = {"P0": "🚨", "P1": "⚠️", "P2": "🔔", "P3": "ℹ️"}
    tag = {"P0": "@all", "P1": "", "P2": "", "P3": ""}
    text = f"{emoji.get(level, '📋')} [{level}] {title}\n\n{body}\n{tag.get(level, '')}"
    payload = json.dumps({"msg_type": "text", "content": {"text": text}}).encode()
    try:
        req = urllib.request.Request(FEISHU_WEBHOOK, data=payload, headers={"Content-Type": "application/json"})
        resp = urllib.request.urlopen(req, timeout=10)
        print(f"[Feishu] {level} 推送完成")
    except Exception as e:
        print(f"[Feishu] 推送失败: {e}")

# ═══ 探针 ═══

def check_hermes_process():
    """Hermes桌面端是否在运行"""
    try:
        r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq hermes*", "/NH"], 
                          capture_output=True, text=True, timeout=10)
        if "hermes" in r.stdout.lower():
            return True, "运行中"
        return False, "未找到Hermes进程"
    except Exception as e:
        return False, str(e)

def check_browser():
    """AdsPower浏览器WS是否可达"""
    try:
        r = urllib.request.urlopen(f"{ADS_API}/api/v1/browser/active?user_id={ADS_PROFILE}", timeout=10)
        data = json.loads(r.read())
        if data.get('code') == 0 and data.get('data', {}).get('status') == 'Active':
            return True, "浏览器活跃"
        return False, f"浏览器状态: {data.get('data', {}).get('status', '未知')}"
    except Exception as e:
        return False, f"连接失败: {e}"

def check_disk():
    """C盘剩余空间"""
    try:
        # 用python获取磁盘空间
        import ctypes
        free_bytes = ctypes.c_ulonglong(0)
        ctypes.windll.kernel32.GetDiskFreeSpaceExW(
            ctypes.c_wchar_p("C:\\"), None, None, ctypes.pointer(free_bytes))
        free_gb = free_bytes.value / 1024**3
        total = 40
        pct = free_gb / total * 100
        return pct > 10, f"剩余 {free_gb:.1f}GB / {total}GB ({pct:.0f}%)"
    except:
        return True, "无法检测磁盘"

def check_database():
    """数据库是否可读写"""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.execute("SELECT 1").fetchone()
        conn.close()
        return True, "正常"
    except Exception as e:
        return False, str(e)

def check_internet():
    """通用网络连通性"""
    for url in ["https://www.baidu.com", "https://www.google.com", "https://seller-my.tiktok.com"]:
        try:
            r = urllib.request.urlopen(url, timeout=8)
            return True, f"可达 ({url} → {r.getcode()})"
        except:
            continue
    return False, "所有出口均不可达"

def get_ip():
    """获取本机公网IP"""
    try:
        r = urllib.request.urlopen("https://myip.ipip.net", timeout=8)
        txt = r.read().decode().strip()
        # 格式: "当前 IP：8.148.234.34  来自于：中国 广东 广州  阿里云"
        return txt
    except:
        return "获取失败"

def check_cron_jobs():
    """检查cron任务是否完整"""
    try:
        r = subprocess.run([HERMES_EXE, "cron", "list"], capture_output=True, text=True, timeout=15)
        output = r.stdout
        issues = []
        for name, expected in CRON_JOBS.items():
            if name not in output:
                issues.append(f"{name}: 缺失")
            elif expected['schedule'] not in output:
                # 模糊匹配
                pass
        if issues:
            return False, "; ".join(issues)
        return True, f"全部{len(CRON_JOBS)}个任务正常"
    except Exception as e:
        return False, str(e)

# ═══ 自动恢复 ═══

def recover_hermes():
    """尝试启动Hermes"""
    try:
        subprocess.Popen([HERMES_EXE], shell=True)
        time.sleep(5)
        ok, msg = check_hermes_process()
        return ok, msg
    except Exception as e:
        return False, str(e)

def recover_browser():
    """尝试重启浏览器"""
    try:
        r = urllib.request.urlopen(
            f"{ADS_API}/api/v1/browser/start?user_id={ADS_PROFILE}&open_tabs=1", timeout=15)
        data = json.loads(r.read())
        if data.get('code') == 0:
            time.sleep(8)
            ok, msg = check_browser()
            return ok, msg
        return False, f"API返回: {data}"
    except Exception as e:
        return False, str(e)

# ═══ 主循环 ═══

def run(fast_mode=False):
    state = load_state()
    now = datetime.now()
    changed = False
    p0_alerts = []
    p1_alerts = []
    p2_alerts = []

    # 1. Hermes进程
    hermes_ok, hermes_msg = check_hermes_process()
    prev = state["checks"].get("hermes", "unknown")
    if prev != ("up" if hermes_ok else "down"):
        state["checks"]["hermes"] = "up" if hermes_ok else "down"
        changed = True
        if not hermes_ok:
            p0_alerts.append(("Hermes进程", hermes_msg))
            log_event("P0", "hermes", hermes_msg)
            # 尝试自动恢复
            recovered, rmsg = recover_hermes()
            if recovered:
                state["checks"]["hermes"] = "up"
                state["recovery_count"] = state.get("recovery_count", 0) + 1
                log_event("INFO", "hermes", f"自动恢复成功: {rmsg}", recovered=True)

    # 2. 浏览器
    browser_ok, browser_msg = check_browser()
    prev = state["checks"].get("browser", "unknown")
    if prev != ("up" if browser_ok else "down"):
        state["checks"]["browser"] = "up" if browser_ok else "down"
        changed = True
        if not browser_ok:
            p1_alerts.append(("AdsPower浏览器", browser_msg))
            log_event("P1", "browser", browser_msg)
            recovered, rmsg = recover_browser()
            if recovered:
                state["checks"]["browser"] = "up"
                state["recovery_count"] = state.get("recovery_count", 0) + 1
                log_event("INFO", "browser", f"自动恢复成功: {rmsg}", recovered=True)

    # 3. 磁盘（非fast模式才查）
    if not fast_mode:
        disk_ok, disk_msg = check_disk()
        prev = state["checks"].get("disk", "unknown")
        status = "ok" if disk_ok else "low"
        if prev != status:
            state["checks"]["disk"] = status
            changed = True
            if not disk_ok:
                p2_alerts.append(("磁盘空间", disk_msg))
                log_event("P2", "disk", disk_msg)

    # 4. 数据库
    db_ok, db_msg = check_database()
    prev = state["checks"].get("database", "unknown")
    if prev != ("up" if db_ok else "down"):
        state["checks"]["database"] = "up" if db_ok else "down"
        changed = True
        if not db_ok:
            p1_alerts.append(("数据库", db_msg))
            log_event("P1", "database", db_msg)

    # 5. 网络
    net_ok, net_msg = check_internet()
    prev = state["checks"].get("internet", "unknown")
    if prev != ("up" if net_ok else "down"):
        state["checks"]["internet"] = "up" if net_ok else "down"
        changed = True
        if not net_ok:
            p2_alerts.append(("TikTok网络", net_msg))
            log_event("P2", "internet", net_msg)

    # 6. Cron任务（非fast模式）
    if not fast_mode:
        cron_ok, cron_msg = check_cron_jobs()
        prev = state["checks"].get("cron", "unknown")
        if prev != ("up" if cron_ok else "down"):
            state["checks"]["cron"] = "up" if cron_ok else "down"
            changed = True
            if not cron_ok:
                p1_alerts.append(("Cron任务", cron_msg))
                log_event("P1", "cron", cron_msg)

    # 7. 自动恢复统计
    rc = state.get("recovery_count", 0)
    if rc > 0:
        p2_alerts.append(("自动恢复", f"本周期已自动恢复 {rc} 次"))

    # ─── 发通知（只在状态变化时）───
    if changed:
        # P0: 致命
        for name, msg in p0_alerts:
            p0_emoji = {"hermes下": "🔥", "恢复": "✅"}
            p0_state = "down" if "未找到" in msg else "up"
            title = f"{'🔥' if '未找到' in msg else '✅'} {name}"
            body = f"{'❌ 进程挂了' if '未找到' in msg else '✅ 已恢复'}\n详情: {msg}"
            notify("P0", title, body)

        # P1: 严重
        for name, msg in p1_alerts:
            is_down = "失败" in msg or "Error" in msg or "Active" not in msg
            title = f"{'⚠️' if is_down else '✅'} {name}"
            body = f"{'异常' if is_down else '已恢复'}\n{msg}"
            notify("P1", title, body)

        # P2: 一般（汇总发）
        if p2_alerts:
            body_lines = [f"{'❌' if '失败' in m or '低' in m else 'ℹ️'} {n}: {m}" for n, m in p2_alerts]
            notify("P2", "系统状态变化", "\n".join(body_lines))

    # 定时报告（每2小时完整模式）
    if not fast_mode:
        ip = get_ip()
        summary = [f"🤖 **全能守护者健康报告**", f"🕐 {now.strftime('%Y-%m-%d %H:%M')}", "", f"🌐 **公网IP**: {ip}", ""]
        STATUS_EMOJI = {"up": "✅", "down": "❌", "ok": "✅", "low": "⚠️", "unknown": "❓"}
        LABELS = {"hermes": "Hermes进程", "browser": "浏览器", "disk": "磁盘空间",
                  "database": "数据库", "internet": "网络", "cron": "定时任务"}
        for k, v in state["checks"].items():
            emoji = STATUS_EMOJI.get(v, "❓")
            label = LABELS.get(k, k)
            summary.append(f"{emoji} **{label}**: {v}")
        summary.append("")
        if rc > 0:
            summary.append(f"🤖 自动恢复: {rc} 次")
        else:
            summary.append(f"🤖 自动恢复: 无异常")
        summary.append("")
        summary.append("📋 任务时间表")
        summary.append("07:00 数据采集 | 09:00 两份日报 | 11:00 GitHub备份")
        summary.append("⏱ 探针每30分钟 | 🩺 完整体检每2小时")
        report = "\n".join(summary)
        notify("P2", "系统健康报告", report)

    save_state(state)
    return 0 if hermes_ok else 1

if __name__ == '__main__':
    import sys
    fast = '--fast' in sys.argv
    sys.exit(run(fast_mode=fast))
