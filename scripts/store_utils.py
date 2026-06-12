#!/usr/bin/env python3
"""
共享工具层 — 所有店铺脚本的统一工具函数
可靠性设计：
- 所有函数接受显式参数（不依赖全局状态）
- 飞书推送含完整错误上报
- 输出捕获兼容旧脚本的 print 风格
"""
import json, os, sqlite3, sys, urllib.request
from contextlib import contextmanager
from io import StringIO


# ── 飞书推送 ──

def push_feishu(webhook_url, text, msg_type="text"):
    """
    推送到飞书，含完整错误信息。
    参数：
        webhook_url: 飞书机器人 webhook URL
        text:       消息内容
        msg_type:   消息类型 (text / post)
    返回：
        (成功bool, 响应文本)
    """
    if not webhook_url:
        print("[push_feishu] 未提供 webhook URL，跳过推送", file=sys.stderr)
        return False, "no webhook url"

    # 如果消息超过 4000 字，截断
    if len(text) > 3800:
        text = text[:3800] + "\n\n... (截断)"

    payload = json.dumps({
        "msg_type": msg_type,
        "content": {"text": text}
    }).encode("utf-8")

    try:
        req = urllib.request.Request(
            webhook_url,
            data=payload,
            headers={"Content-Type": "application/json"}
        )
        resp = urllib.request.urlopen(req, timeout=15)
        resp_body = resp.read().decode()
        ok = '"ok"' in resp_body.lower() or '"code":0' in resp_body
        return ok, resp_body
    except Exception as e:
        err_msg = f"推送失败: {e}"
        print(f"[push_feishu] {err_msg}", file=sys.stderr)
        return False, err_msg


# ── 输出捕获 ──

@contextmanager
def capture_output():
    """
    上下文管理器：捕获 print 输出到 StringIO，
    兼容旧脚本的 print 重写模式。
    用法：
        with capture_output() as out:
            print("hello")
        result = out.getvalue()
    """
    _stdout = sys.stdout
    _stderr = sys.stderr
    buf = StringIO()
    try:
        sys.stdout = buf
        sys.stderr = buf
        yield buf
    finally:
        sys.stdout = _stdout
        sys.stderr = _stderr


# ── 数据库 ──

def get_db(db_path):
    """获取 SQLite 连接（row_factory 已配置好）"""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def get_db_path(store):
    """从店铺配置获取 DB 路径"""
    return store.get("paths", {}).get("db",
        os.path.join(os.path.expanduser("~"), ".tkads", "data", "analytics.db"))


# ── 日期工具 ──

def date_range(days_back=31):
    """返回 (今天, 昨天, N天前) 的日期字符串"""
    from datetime import datetime, timedelta
    today = datetime.now().strftime("%Y-%m-%d")
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    past = (datetime.now() - timedelta(days=days_back)).strftime("%Y-%m-%d")
    return today, yesterday, past


# ── 快速验证 ──
if __name__ == "__main__":
    # 测试输出捕获
    with capture_output() as buf:
        print("test message")
    assert "test message" in buf.getvalue()
    print("[store_utils] 基本功能验证通过")
