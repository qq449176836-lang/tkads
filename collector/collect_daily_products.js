const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ADSPOWER_API = 'http://local.adspower.net:50325';
const PROFILE_SN = '27';

async function getWsEndpoint() {
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

(async () => {
    const ws = await getWsEndpoint();
    const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
    const pages = await browser.pages();
    const startTime = Date.now();

    // === STEP 1: Open product analysis and capture ALL API data ===
    console.log('[1/3] 打开商品分析页 & 捕获API数据...');
    let page = pages.find(p => p.url().includes('product-analysis'));
    if (!page) page = await browser.newPage();

    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');

    const raw = { productList: null, metrics: [], skus: [], details: [] };

    cdp.on('Network.responseReceived', async (ev) => {
        const url = ev.response?.url || '';
        try {
            const resp = await cdp.send('Network.getResponseBody', { requestId: ev.requestId });
            const body = resp.base64Encoded ? Buffer.from(resp.body, 'base64').toString('utf8') : resp.body;
            if (url.includes('ttp/product/list') && !raw.productList) {
                raw.productList = body; console.log('  [OK] product list');
            }
            if (url.includes('product_key_metric')) { raw.metrics.push(body); }
            if (url.includes('ttp/product/sku/list')) { raw.skus.push(body); }
            if (url.includes('detail/info')) { raw.details.push(body); }
        } catch(e) {}
    });

    // Force fresh load
    await page.goto('https://seller-my.tiktok.com/compass/product-analysis?shop_region=MY&lang=en&_t=' + Date.now(), {
        waitUntil: 'domcontentloaded', timeout: 90000
    });
    await new Promise(r => setTimeout(r, 6000));

    // Click each product detail to trigger daily metrics
    console.log('[2/3] 点击商品详情获取逐日数据...');
    const clickOrder = [];
    for (let i = 0; i < 15; i++) {
        const prodInfo = await page.evaluate(() => {
            for (const b of document.querySelectorAll('button'))
                if (b.textContent.includes('详细信息') && b.offsetParent) {
                    const row = b.closest('[class*=row]') || b.closest('tr') || b.parentElement;
                    return { name: (row?.textContent || '').substring(0, 60) };
                }
            return null;
        });
        const clicked = await page.evaluate(() => {
            for (const b of document.querySelectorAll('button'))
                if (b.textContent.includes('详细信息') && b.offsetParent) { b.click(); return true; }
            return false;
        });
        if (!clicked) break;
        clickOrder.push(prodInfo?.name || 'unknown');
        await new Promise(r => setTimeout(r, 800));
    }

    // Wait for all metrics to arrive
    console.log('  等待每日数据加载...');
    const waitStart = Date.now();
    while (raw.metrics.length < clickOrder.length && Date.now() - waitStart < 15000) {
        await new Promise(r => setTimeout(r, 500));
    }
    console.log(`  已获 ${raw.metrics.length}/${clickOrder.length} 条每日数据`);

    // === STEP 3: Parse everything ===
    console.log('[3/3] 解析合并数据...');

    // 3a. Product list (basic info)
    const products = {};
    if (raw.productList) {
        try {
            const json = JSON.parse(raw.productList);
            const items = json.data?.items || [];
            for (const item of items) {
                const m = item.meta;
                const s = item.stats_v3?.total || {};
                products[m.product_id] = {
                    name: m.product_name,
                    status: m.product_status,
                    total_7d: {
                        impressions_pv: parseInt(s.product_impression_pv) || 0,
                        impressions_uv: parseInt(s.product_impression_uv) || 0,
                        clicks_pv: parseInt(s.product_click_pv) || 0,
                        clicks_uv: parseInt(s.product_click_uv) || 0,
                        ctr_pv: parseFloat(s.product_ctr_pv) || 0,
                        add_cart_pv: parseInt(s.add_to_cart_cnt_pv) || 0,
                        gmv: parseFloat(s.gmv?.amount) || 0,
                        orders: parseInt(s.orders) || 0,
                        sku_orders: parseInt(s.sku_orders) || 0,
                        items_sold: parseInt(s.items_sold) || 0,
                        customers: parseInt(s.customers) || 0
                    },
                    daily: {},
                    skus: []
                };
            }
            console.log(`  ${Object.keys(products).length} products`);
        } catch(e) { console.log('  Parse error:', e.message); }
    }

    // 3b. Parse daily metrics - map to products by click order
    const prodList = Object.entries(products);
    for (let mi = 0; mi < raw.metrics.length && mi < prodList.length; mi++) {
        try {
            const json = JSON.parse(raw.metrics[mi]);
            const pid = prodList[mi][0]; // ith product
            const dataArr = json.data || [];
            for (const dataItem of dataArr) {
                for (const iv of dataItem.intervals || []) {
                    const date = iv.start_date;
                    const vals = iv.rows?.[0]?.values || {};
                    const daily = { _raw: {} };
                    
                    for (const [mk, mv] of Object.entries(vals)) {
                        if (typeof mv === 'string') {
                            try {
                                const pv = JSON.parse(mv);
                                daily._raw[mk] = {
                                    value: pv.value, amount: pv.amount,
                                    amount_formatted: pv.amount_formatted,
                                    compareRate: pv.compareRate, compareValue: pv.compareValue
                                };
                                // Extract known metrics
                                const numericVal = pv.value !== undefined ? parseFloat(pv.value) : null;
                                const amountVal = pv.amount !== undefined ? parseFloat(pv.amount) : null;
                                if (mk === '7450') daily.gmv_direct = amountVal || 0;
                                if (mk === '7468') daily.gmv = amountVal || 0;
                                if (mk === '7479') daily.gmv_with_tax = amountVal || 0;
                                if (mk === '7483') daily.gmv_directcon = amountVal || 0;
                                if (mk === '7484') daily.gmv_indirectcon = amountVal || 0;
                                if (mk === '7459') daily.impressions_pv = numericVal || 0;
                                if (mk === '7466') daily.clicks_pv = numericVal || 0;
                                if (mk === '7476') daily.orders = numericVal || 0;
                                if (mk === '7456') daily.metric_7456 = numericVal || 0;
                                if (mk === '7485' || mk === '7488') daily['rate_' + mk] = parseFloat(pv.compareRate) || 0;
                            } catch(e) { daily['_id_' + mk] = mv; }
                        }
                    }
                    products[pid].daily[date] = daily;
                }
            }
        } catch(e) {}
    }
    const dailyCount = Object.values(products).reduce((s, p) => s + Object.keys(p.daily).length, 0);

    // 3c. Parse SKUs
    let skuCount = 0;
    for (let si = 0; si < raw.skus.length && si < prodList.length; si++) {
        try {
            const json = JSON.parse(raw.skus[si]);
            const items = json.data?.items || json.data?.data || [];
            if (items.length > 0) {
                const pid = prodList[si][0];
                if (products[pid]) {
                    products[pid].skus = items.map(item => ({
                        sku_id: item.meta.sku_id,
                        property: item.meta.sku_property_value || '',
                        gmv: parseFloat(item.stats?.sku_gmv?.amount) || 0,
                        orders: item.stats?.sku_order_cnt || 0,
                        units_sold: item.stats?.sku_unit_sold_cnt || 0
                    }));
                    skuCount += items.length;
                }
            }
        } catch(e) {}
    }

    // === BUILD OUTPUT ===
    const today = new Date().toISOString().split('T')[0];
    const allDates = [...new Set(Object.values(products).flatMap(p => Object.keys(p.daily)))].sort();
    const dailyTotals = {};
    for (const date of allDates) {
        dailyTotals[date] = { gmv: 0, orders: 0, impressions: 0, clicks: 0 };
        for (const p of Object.values(products)) {
            const d = p.daily[date];
            if (d) {
                dailyTotals[date].gmv += d.gmv || 0;
                dailyTotals[date].orders += d.orders || 0;
                dailyTotals[date].impressions += d.impressions_pv || 0;
                dailyTotals[date].clicks += d.clicks_pv || 0;
            }
        }
    }

    const output = {
        date: today,
        total_products: Object.keys(products).length,
        daily_dates: allDates,
        daily_summary: dailyTotals,
        products: Object.fromEntries(
            Object.entries(products).map(([pid, p]) => [pid, {
                name: p.name, total_7d: p.total_7d, daily: p.daily, skus: p.skus
            }])
        )
    };

    const outPath = path.join(__dirname, 'daily_products_' + today + '.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`\n========== 📊 逐日商品数据 ==========`);
    console.log(`耗时: ${elapsed}s | 商品: ${Object.keys(products).length} | 天数: ${allDates.length} | SKU: ${skuCount}`);
    console.log(`\n--- 每日汇总 ---`);
    for (const date of allDates) {
        const d = dailyTotals[date];
        console.log(`  ${date} | GMV RM${String(d.gmv.toFixed(2)).padStart(9)} | ${String(d.orders).padStart(3)}单 | ${String(d.impressions).padStart(7)}曝光 | ${String(d.clicks).padStart(5)}点击`);
    }
    console.log(`\n[SAVED] ${outPath}`);
    console.log(`[DONE] ${elapsed}s`);

    await page.close();
    await browser.disconnect();
})().catch(e => { console.error('[ERROR]', e.message); process.exit(1); });
