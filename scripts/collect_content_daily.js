// Content daily breakdown: LIVE, Video & Product Card daily data
// Uses us_overview_hour_trend API with named fields
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ADSPOWER_API = 'http://local.adspower.net:50325';
const PROFILE_SN = '27';

function getWsEndpoint() {
    return new Promise((resolve, reject) => {
        http.get(`${ADSPOWER_API}/api/v1/browser/start?serial_number=${PROFILE_SN}&open_tabs=1`, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(data);
                    if (j.code === 0 && j.data?.ws?.puppeteer) resolve(j.data.ws.puppeteer);
                    else reject(new Error('Failed: ' + data));
                } catch(e) { reject(e); }
            });
        }).on('error', reject);
    });
}

function parseAmount(val) {
    if (!val) return 0;
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
        try { 
            const p = JSON.parse(val);
            if (typeof p === 'number') return p;
            if (p && typeof p === 'object') return parseFloat(p.amount) || parseFloat(p.value) || 0;
            return parseFloat(p) || 0;
        } catch(e) { return parseFloat(val) || 0; }
    }
    return 0;
}

(async () => {
    const startTime = Date.now();
    const ws = await getWsEndpoint();
    const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
    
    const today = new Date().toISOString().split('T')[0];
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    
    let hourlyTrendData = null;
    let overviewStatsData = null;
    
    cdp.on('Network.responseReceived', async (ev) => {
        const url = ev.response?.url || '';
        const status = ev.response?.status || 0;
        if (status !== 200) return;
        try {
            const resp = await cdp.send('Network.getResponseBody', { requestId: ev.requestId });
            const body = resp.base64Encoded ? Buffer.from(resp.body, 'base64').toString('utf8') : resp.body;
            if (!body.startsWith('{') && !body.startsWith('[')) return;
            if (url.includes('hour_trend')) hourlyTrendData = JSON.parse(body);
            if (url.includes('overview_stats')) overviewStatsData = JSON.parse(body);
        } catch(e) {}
    });
    
    console.log('[1/3] Loading overview page...');
    await page.goto('about:blank');
    await cdp.send('Network.clearBrowserCache');
    await new Promise(r => setTimeout(r, 1000));
    
    await page.goto('https://seller-my.tiktok.com/compass/data-overview?shop_region=MY&lang=en&_t=' + Date.now(), {
        waitUntil: 'networkidle0', timeout: 60000
    });
    await new Promise(r => setTimeout(r, 10000));
    
    console.log('[2/3] Parsing data...');
    
    // --- Parse overview_stats (daily summary metrics) ---
    let dailyMetrics = {};
    if (overviewStatsData?.data?.[0]?.intervals?.[0]?.rows?.[0]?.values) {
        const v = overviewStatsData.data[0].intervals[0].rows[0].values;
        dailyMetrics = {
            gmv: parseAmount(v.cl_pay_amt),
            orders: parseInt(v.cl_pay_sku_order_cnt) || 0,
            customers: parseInt(v.cl_pay_order_ucnt) || 0,
            visitors: parseInt(v.product_click_ucnt) || 0,
            items_sold: parseInt(v.cl_pay_sub_order_cnt) || 0,
            impressions: parseInt(v.product_show_cnt) || 0,
            unique_impressions: parseInt(v.product_show_ucnt) || 0,
        };
    }
    
    // --- Parse hourly trend (LIVE/Video/Prod Card breakdown) ---
    const result = {
        date: today,
        daily_metrics: dailyMetrics,
        content_breakdown: {
            live: { gmv: 0, direct_gmv: 0, indirect_gmv: 0, affiliate_gmv: 0, seller_gmv: 0 },
            video: { gmv: 0, direct_gmv: 0, indirect_gmv: 0, affiliate_gmv: 0, seller_gmv: 0 },
            product_card: { gmv: 0, affiliate_gmv: 0, seller_search_gmv: 0, seller_shoptab_gmv: 0 },
        },
        hourly: [],
        summary: {}
    };
    
    if (hourlyTrendData?.data?.[0]?.intervals) {
        const intervals = hourlyTrendData.data[0].intervals;
        
        for (const interval of intervals) {
            const row = interval.rows?.[0]?.values || {};
            const date = row.date || interval.start_date?.split(' ')[0] || today;
            const hour = row.hour || interval.start_date?.split(' ')[1]?.split(':')[0] || '00';
            
            const entry = {
                datetime: `${date} ${hour}:00`,
                date, hour,
                live_gmv: parseAmount(row.flow_con_cl_live_pay_amt),
                live_direct: parseAmount(row.livecon_attr_directcon_pay_amt),
                live_indirect: parseAmount(row.livecon_attr_indirectcon_pay_amt),
                live_affiliate: parseAmount(row.flow_con_cl_live_affiliate_pay_amt),
                live_seller: parseAmount(row.self_operated_live_pay_amt),
                video_gmv: parseAmount(row.flow_con_cl_video_pay_amt),
                video_direct: parseAmount(row.videocon_attr_directcon_pay_amt),
                video_indirect: parseAmount(row.videocon_attr_indirectcon_pay_amt),
                video_affiliate: parseAmount(row.flow_con_cl_video_affiliate_pay_amt),
                video_seller: parseAmount(row.self_operated_video_pay_amt),
                product_card_gmv: parseAmount(row.product_card_pay_amt),
                pc_affiliate: parseAmount(row.affiliate_content_documentary_product_card_payment_amount),
                pc_seller_search: parseAmount(row.self_prodcardcon_attr_search_pay_amt_1d),
                pc_seller_shoptab: parseAmount(row.self_prodcardcon_attr_shoptab_pay_amt_1d),
                total_gmv: parseAmount(row.cl_pay_amt),
                orders: parseInt(row.cl_pay_sku_order_cnt) || 0,
                customers: parseInt(row.cl_pay_order_ucnt) || 0,
                product_views: parseInt(row.product_show_cnt) || 0,
                product_clicks: parseInt(row.product_click_cnt) || 0,
            };
            
            result.hourly.push(entry);
            
            const c = result.content_breakdown;
            c.live.gmv += entry.live_gmv;
            c.live.direct_gmv += entry.live_direct;
            c.live.indirect_gmv += entry.live_indirect;
            c.live.affiliate_gmv += entry.live_affiliate;
            c.live.seller_gmv += entry.live_seller;
            c.video.gmv += entry.video_gmv;
            c.video.direct_gmv += entry.video_direct;
            c.video.indirect_gmv += entry.video_indirect;
            c.video.affiliate_gmv += entry.video_affiliate;
            c.video.seller_gmv += entry.video_seller;
            c.product_card.gmv += entry.product_card_gmv;
            c.product_card.affiliate_gmv += entry.pc_affiliate;
            c.product_card.seller_search_gmv += entry.pc_seller_search;
            c.product_card.seller_shoptab_gmv += entry.pc_seller_shoptab;
        }
        
        const totalGmv = result.hourly.reduce((s, h) => s + h.total_gmv, 0);
        const totalOrders = result.hourly.reduce((s, h) => s + h.orders, 0);
        const totalCustomers = result.hourly.reduce((s, h) => s + h.customers, 0);
        
        result.summary = {
            hourly_intervals: intervals.length,
            total_gmv: totalGmv,
            total_orders: totalOrders,
            total_customers: totalCustomers,
        };
        
        const fmt = (v) => (v || 0).toFixed(2);
        const c = result.content_breakdown;
        console.log(`\n  === Daily Content Breakdown ===`);
        console.log(`  LIVE:        RM ${fmt(c.live.gmv)} (direct: RM${fmt(c.live.direct)}, affiliate: RM${fmt(c.live.affiliate)})`);
        console.log(`  Video:       RM ${fmt(c.video.gmv)} (direct: RM${fmt(c.video.direct)}, affiliate: RM${fmt(c.video.affiliate)})`);
        console.log(`  Product Card:RM ${fmt(c.product_card.gmv)} (affiliate: RM${fmt(c.product_card.affiliate_gmv)}, seller: RM${fmt(c.product_card.seller_search_gmv + c.product_card.seller_shoptab_gmv)})`);
        console.log(`  ─────────────────────────────────────`);
        console.log(`  Total GMV:   RM ${fmt(totalGmv)} | Orders: ${totalOrders} | Customers: ${totalCustomers}`);
    } else {
        console.log('  No hourly trend data');
    }
    
    // === Save ===
    console.log('\n[3/3] Saving...');
    const outPath = path.join(__dirname, `content_daily_${today}.json`);
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`[DONE] ${outPath} (${elapsed}s)`);
    
    await page.close();
    await browser.disconnect();
    process.exit(0);
})().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
