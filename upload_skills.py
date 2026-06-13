#!/usr/bin/env python3
"""上传Hermes技能包到GitHub（按功能分类）"""
import json, urllib.request, base64, os

TOKEN = open(os.path.join(os.path.expanduser("~"), ".tkads", ".ghtoken")).read().strip()
BASE = "https://api.github.com/repos/qq449176836-lang/hermes/contents"
home = os.path.expanduser("~")

def api_call(method, path, data=None):
    """通用 GitHub API 调用"""
    url = f"{BASE}/{path}" if not path.startswith("http") else path
    data_bytes = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=data_bytes,
        headers={"Authorization": f"token {TOKEN}", "Content-Type": "application/json", "User-Agent": "Hermes-Agent"},
        method=method)
    try:
        resp = json.loads(urllib.request.urlopen(req).read())
        return resp
    except urllib.error.HTTPError as e:
        err_body = e.read()
        try: return json.loads(err_body)
        except: return {"message": f"HTTP {e.code}: {err_body.decode()[:200]}"}

def upload(path, content, msg):
    """上传或更新文件"""
    b64 = base64.b64encode(content.encode()).decode()
    result = api_call("PUT", path, {"message": msg, "content": b64, "branch": "main"})
    if result.get("content"):
        print(f"  ✅ {path}  ({result['content']['size']} bytes)")
        return result["content"]["sha"]
    elif result.get("message") == "sha was supposed to be...":  # 文件已存在需更新
        existing = api_call("GET", path)
        if existing.get("sha"):
            result2 = api_call("PUT", path, {
                "message": msg + " (更新)", "content": b64,
                "sha": existing["sha"], "branch": "main"
            })
            if result2.get("content"):
                print(f"  ✅ {path} (更新, {result2['content']['size']} bytes)")
                return result2["content"]["sha"]
    print(f"  ❌ {path}: {result.get('message','?')}")
    return None

def delete_file(path):
    """删除文件"""
    existing = api_call("GET", path)
    if existing.get("sha"):
        result = api_call("DELETE", path, {"message": f"clean: 删除旧路径 {path}", "sha": existing["sha"], "branch": "main"})
        if result.get("content") is None:
            print(f"  🗑️ {path}")
            return True
        else:
            print(f"  ❌ 删除失败 {path}: {result.get('message','?')}")
    return False

def read_file(p):
    with open(p, 'r', encoding='utf-8') as f:
        return f.read()

print("📤 上传技能包（按功能分类）...\n")

# === 上传到新路径 ===
c1 = read_file(os.path.join(home, ".hermes", "skills", "ecommerce", "tkads-automation", "SKILL.md"))
upload("skills/ad-automation/gmvmax/SKILL.md", c1, "skills: GMV Max 广告自动化技能包")

c2 = read_file(os.path.join(home, ".hermes", "skills", "ecommerce", "tkads-daily-collection", "SKILL.md"))
upload("skills/data-collection/tkads-daily/SKILL.md", c2, "skills: TikTok 广告每日数据采集技能包")

# === 删除旧路径 ===
print("\n🗑️ 清理旧 ecommerce 路径...")
delete_file("skills/ecommerce/tkads-automation/SKILL.md")
delete_file("skills/ecommerce/tkads-daily-collection/SKILL.md")

print("\n🎉 全部完成！新仓库结构：")
print("  skills/ad-automation/gmvmax/SKILL.md           ← GMV Max 广告自动化")
print("  skills/data-collection/tkads-daily/SKILL.md    ← TikTok 广告每日数据采集")
print("  docs/                                           ← 纯文档")
print("  scripts/                                        ← 工具脚本")
