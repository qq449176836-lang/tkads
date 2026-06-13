# tkads v4 — 命名空间命令 + 兼容快捷命令
# 所有逻辑在 tkads.js 中
# 使用: source ~/.tkads/tkads.sh

TKADS_JS="$HOME/.tkads/tkads.js"

# 统一入口
function tkads() { node "$TKADS_JS" "$@"; }

# ============ 快捷命令 (兼容 v3) ============
function tkads-list()      { node "$TKADS_JS" list "$@"; }
function tkads-pause()     { node "$TKADS_JS" pause "$@"; }
function tkads-resume()    { node "$TKADS_JS" resume "$@"; }
function tkads-update()    { node "$TKADS_JS" update "$@"; }
function tkads-creatives() { node "$TKADS_JS" creatives; }
function tkads-products()  { node "$TKADS_JS" products "$@"; }
function tkads-post()      { node "$TKADS_JS" post "$@"; }

# ============ 命名空间别名 (v4 新) ============
function tkads.ad.list()        { node "$TKADS_JS" list "$@"; }
function tkads.ad.pause()       { node "$TKADS_JS" pause "$@"; }
function tkads.ad.resume()      { node "$TKADS_JS" resume "$@"; }
function tkads.ad.update()      { node "$TKADS_JS" update "$@"; }
function tkads.creative.list()  { node "$TKADS_JS" creatives; }
function tkads.ad.products()    { node "$TKADS_JS" products "$@"; }
function tkads.creative.post()  { node "$TKADS_JS" post "$@"; }
function tkads.export()        { node "$TKADS_JS" export "$@"; }
function tkads.gmvrank()       { node "$TKADS_JS" gmvrank "$@"; }
function tkads.gmv.rank()      { node "$TKADS_JS" gmvrank "$@"; }
function tkads.config()        { node "$TKADS_JS" config "$@"; }

# ============ 直接别名 (bash alias 形式) ============
alias tkads.ad.list="node $TKADS_JS list"
alias tkads.ad.pause="node $TKADS_JS pause"
alias tkads.ad.resume="node $TKADS_JS resume"
alias tkads.ad.update="node $TKADS_JS update"
alias tkads.creative.list="node $TKADS_JS creatives"
alias tkads.ad.products="node $TKADS_JS products"
alias tkads.creative.post="node $TKADS_JS post"
alias tkads.export="node $TKADS_JS export"
alias tkads.gmvrank="node $TKADS_JS gmvrank"
alias tkads.gmv.rank="node $TKADS_JS gmvrank"
alias tkads.config="node $TKADS_JS config"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ✅ tkads v4 已加载 (命名空间命令 + 自动 WS 检测+唤醒)     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  快捷命令 (兼容 v3):"
echo "  tkads-list [天数]             列出广告"
echo "  tkads-pause <id>             暂停广告"
echo "  tkads-resume <id>            恢复广告"
echo "  tkads-update <id> <roi>      改ROI"
echo "  tkads-creatives              作品概览"
echo "  tkads-products <id>          商品数据"
echo "  tkads-post <id> [mode]       视频分析"
echo "  tkads-export [天数]          导出CSV数据"
echo "  tkads-gmvrank <topN>         GMV排名"
echo "  tkads-config [key]           查看配置"
echo ""
echo "  命名空间命令 (v4 新):"
echo "  tkads.ad.list [天数]          列出广告"
echo "  tkads.ad.pause <id>          暂停广告"
echo "  tkads.ad.resume <id>         恢复广告"
echo "  tkads.ad.update <id> <roi>   改ROI"
echo "  tkads.creative.list           作品概览"
echo "  tkads.ad.products <id>       商品数据"
echo "  tkads.creative.post <id> [mode] 视频分析"
echo "  tkads.export [天数]             导出CSV数据"
echo "  tkads.gmvrank <topN>            GMV排名"
echo "  tkads.gmv.rank <topN>           GMV排名"
echo "  tkads.config [key]              查看配置"
echo ""
