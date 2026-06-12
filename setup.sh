#!/usr/bin/env bash
# TKADS v4 — 一键安装脚本
set -e

echo "========================================"
echo "  TKADS v4 安装程序"
echo "  TikTok Ads 自动化运营系统"
echo "========================================"
echo ""

# 检测环境
OS="$(uname -s)"
echo "🔍 检测系统: $OS"

# 检测 Python
if command -v python3 &> /dev/null; then
    PY=python3
elif command -v python &> /dev/null; then
    PY=python
else
    echo "❌ 请先安装 Python 3.10+"
    exit 1
fi
echo "✅ Python: $($PY --version)"

# 检测 Node.js
if command -v node &> /dev/null; then
    echo "✅ Node.js: $(node --version)"
else
    echo "⚠️ 建议安装 Node.js 18+ (部分脚本需要)"
fi

# 创建配置
if [ ! -f .env ]; then
    cp template/env.example .env
    echo "📝 已创建 .env 文件，请编辑填入配置"
else
    echo "✅ .env 已存在"
fi

# 检查 stores.json
if [ ! -f scripts/stores.json ]; then
    # 尝试从 .env 生成
    echo "⚠️ scripts/stores.json 不存在"
    echo "   请参考 template/stores.example.json 创建"
fi

# 安装 Python 依赖
echo ""
echo "📦 安装 Python 依赖..."
$PY -m pip install --upgrade pip -q
$PY -m pip install requests psycopg2-binary fastapi uvicorn -q

echo ""
echo "========================================"
echo "✅ TKADS v4 安装完成！"
echo ""
echo "下一步："
echo "  1. 编辑 .env 填入配置"
echo "  2. 编辑 scripts/stores.json 配置店铺"
echo "  3. 运行 python scripts/daily-collect.py 测试采集"
echo "========================================"
