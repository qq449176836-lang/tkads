#!/usr/bin/env python3
"""
统一配置加载器 — 从 stores.json 读取店铺配置
可靠性设计：
- 配置加载失败时自动降级为旧默认值
- 所有路径自动 expanduser
- 单次加载、全局缓存
"""
import json, os, sys

_CONFIG_CACHE = None
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))

def _default_store():
    """内置默认值（配置加载失败时的降级方案）"""
    home = os.path.expanduser("~")
    appdata = os.environ.get('APPDATA', os.path.join(home, 'AppData', 'Roaming'))
    return {
        "id": "hanmac_my",
        "name": "Hanmac.my",
        "domain": "seller-my.tiktok.com",
        "sid": "7494105016200037977",
        "advid": "7569565674088136705",
        "profile": "k1456ta2",
        "timezone": "+08:00",
        "webhooks": {
            "report": None,
            "alert": None
        },
        "paths": {
            "db": os.path.join(home, ".tkads", "data", "analytics.db"),
            "collector": os.path.join(home, ".tkads", "collect_day_by_day.py"),
            "tkads_js": os.path.join(home, ".tkads", "tkads.js"),
            "monitor_state": os.path.join(home, ".hermes", "scripts", ".monitor_state.json"),
            "monitor_log": os.path.join(home, ".hermes", "scripts", ".monitor_log.jsonl")
        },
        "hermes_exe": os.path.join(
            appdata,
            "cn.org.hermesagent.desktop", "runtime", "versions", "0.16.0-cn.6",
            "hermes-agent-cn-runtime-win32-x64.exe"
        ),
        "ads_api": "http://local.adspower.net:50325",
        "cron": {
            "daily_collect": "0 7 * * *",
            "daily_report": "0 9 * * *",
            "daily_creator_report": "0 9 * * *",
            "daily_github_backup": "0 11 * * *",
            "guardian_full": "every 120m",
            "guardian_fast": "every 30m"
        }
    }


def _load_all():
    """加载 stores.json，失败时返回 [默认配置]"""
    global _CONFIG_CACHE
    if _CONFIG_CACHE is not None:
        return _CONFIG_CACHE

    json_path = os.path.join(_SCRIPTS_DIR, "stores.json")
    if os.path.exists(json_path):
        try:
            with open(json_path, encoding="utf-8") as f:
                stores = json.load(f)
            # 补全路径（expanduser）
            for store in stores:
                paths = store.get("paths", {})
                for k, v in paths.items():
                    if v and "~" in str(v):
                        paths[k] = os.path.expanduser(v)
            _CONFIG_CACHE = stores
            return stores
        except Exception as e:
            print(f"[store_config] 加载 stores.json 失败: {e}，使用默认值", file=sys.stderr)

    _CONFIG_CACHE = [_default_store()]
    return _CONFIG_CACHE


def get_store(store_id="hanmac_my"):
    """获取指定店铺的配置字典。找不到时返回默认配置。"""
    stores = _load_all()
    for s in stores:
        if s.get("id") == store_id:
            return s
    # 降级：返回第一个店铺或默认
    if stores:
        return stores[0]
    return _default_store()


def get_webhook(store_id, key="report"):
    """获取 webhook URL。优先从 stores.json 读，其次从环境变量/文件降级。"""
    store = get_store(store_id)
    wh = store.get("webhooks", {}).get(key)
    if wh:
        return wh

    # 降级：从文件读取
    home = os.path.expanduser("~")
    filenames = {
        "report": os.path.join(home, ".hermes", "scripts", ".report_webhook"),
        "alert": os.path.join(home, ".hermes", "scripts", ".alert_webhook"),
    }
    fpath = filenames.get(key)
    if fpath and os.path.exists(fpath):
        try:
            with open(fpath) as f:
                return f.read().strip()
        except Exception:
            pass

    # 再降级：从环境变量
    env_keys = {
        "report": "FEISHU_BOT_WEBHOOK",
        "alert": "FEISHU_ALERT_WEBHOOK",
    }
    return os.environ.get(env_keys.get(key, "FEISHU_BOT_WEBHOOK"))


def get_cron_schedule(store_id, job_name):
    """获取 cron 调度表达式，找不到时返回 None"""
    store = get_store(store_id)
    return store.get("cron", {}).get(job_name)


def reload():
    """强制重新加载配置（调试用）"""
    global _CONFIG_CACHE
    _CONFIG_CACHE = None
    return _load_all()


# 快速验证
if __name__ == "__main__":
    store = get_store()
    print(f"店铺: {store['name']} ({store['id']})")
    print(f"DB: {store['paths']['db']}")
    print(f"Profile: {store['profile']}")
    print(f"Report Webhook: {get_webhook('hanmac_my', 'report')}")
