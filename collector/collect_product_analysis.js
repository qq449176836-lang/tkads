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
    const page = await browser.newPage();

    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');

    // Capture API payloads
    const captured = { listBody: '', listResp: '', detailReqs: [], detailResps: [], skuBodies: [], skuResps: [] };
    let detailCount = 0;

    cdp.on('Network.requestWillBeSent', (ev) => {
        const url = ev.request.url;
        if (url.includes('product/list') && !captured.listBody) {
            cdp.send('Network.getRequestPostData', { requestId: ev.requestId })
                .then(r => { if (r.postData) captured.listBody = r.postData; }).catch(() => {});
        }
        if (url.includes('detail/info')) {
            cdp.send('Network.getRequestPostData', { requestId: ev.requestId })
                .then(r => { if (r.postData) captured.detailReqs.push(r.postData); }).catch(() => {});
        }
        if (url.includes('sku/list')) {
            cdp.send('Network.getRequestPostData', { requestId: ev.requestId })
                .then(r => { if (r.postData) captured.skuBodies.push(r.postData); }).catch(() => {});
        }
    });

    cdp.on('Network.responseReceived', async (ev) => {
        const url = ev.response.url;
        try {
            const resp = await cdp.send('Network.getResponseBody', { requestId: ev.requestId });
            const body = resp.base64Encoded ? Buffer.from(resp.body, 'base64').toString('utf8') : resp.body;
            if (url.includes('product/list') && !captured.listResp) {
                captured.listResp = body;
                console.log('[GOT] product list');
            }
            if (url.includes('detail/info')) {
                captured.detailResps.push(body);
                detailCount++;
                console.log('[GOT] detail #' + detailCount);
            }
            if (url.includes('sku/list')) {
                captured.skuResps.push(body);
            }
        } catch (e) {}
    });

    // Navigate
    console.log('[NAV] Loading product analysis...');
    await page.goto('https://seller-my.tiktok.com/compass/product-analysis?shop_region=MY&lang=en', {
        waitUntil: 'networkidle0', timeout: 60000
    });
    await new Promise(r => setTimeout(r, 6000));

    // Click detail buttons for products (up to 5)
    for (let i = 0; i < 5; i++) {
        const detailBtns = await page.evaluate(() => {
            const btns = document.querySelectorAll('button');
            const results = [];
            for (const b of btns) {
                if (b.textContent.includes('详细信息') && b.offsetParent !== null) {
                    results.push(true);
                }
            }
            return results.length;
        });
        if (detailBtns === 0) break;
        
        await page.evaluate(() => {
            const btns = document.querySelectorAll('button');
            for (const b of btns) {
                if (b.textContent.includes('详细信息') && b.offsetParent !== null) {
                    b.click();
                    return;
                }
            }
        });
        await new Promise(r => setTimeout(r, 3000));
    }

    // Process results
    const today = new Date().toISOString().split('T')[0];
    const output = {
        date: today,
        source: 'compass/product-analysis',
        total_products: 0,
        products: [],
        categories: {}
    };

    // Parse product list
    if (captured.listResp) {
        try {
            const json = JSON.parse(captured.listResp);
            if (json.data?.items) {
                output.total_products = json.data.items.length;
                for (const item of json.data.items) {
                    const m = item.meta;
                    const s = item.stats_v3?.total || {};
                    const gmv = s.gmv?.amount ? parseFloat(s.gmv.amount) : 0;
                    output.products.push({
                        product_id: m.product_id,
                        product_name: m.product_name,
                        status: m.product_status,
                        gmv_range: m.gmv_range,
                        gmv_7d: gmv,
                        orders_7d: parseInt(s.orders) || 0,
                        customers_7d: parseInt(s.customers) || 0,
                        impressions_7d: parseInt(s.product_impression_pv) || 0,
                        clicks_7d: parseInt(s.product_click_pv) || 0,
                        add_to_cart_7d: parseInt(s.add_to_cart_cnt_pv) || 0,
                        inventory: parseInt(m.inventory_cnt) || 0,
                        min_price: item.meta.min_sale_price?.amount || '',
                        max_price: item.meta.max_sale_price?.amount || '',
                        rating: item.meta.rating || '',
                        reviews: parseInt(item.meta.reviews_cnt) || 0,
                        category_name: '',
                        category_lvl1: 'Bayi & Materniti',
                        category_lvl2: '',
                        category_lvl3: '',
                        skus: []
                    });
                }
                console.log(`\n[OK] ${output.products.length} products in list`);
            }
        } catch (e) { console.log('[ERROR] Parse product list:', e.message); }
    }

    // Merge detail info (category name)
    for (const resp of captured.detailResps) {
        try {
            const json = JSON.parse(resp);
            const info = json.data?.info;
            if (info?.id) {
                const prod = output.products.find(p => p.product_id === info.id);
                if (prod) {
                    prod.category_name = info.category_name || '';
                    prod.inventory = info.inventory_cnt || prod.inventory;
                    prod.min_price = info.min_sale_price?.amount || prod.min_price;
                    prod.max_price = info.max_sale_price?.amount || prod.max_price;
                    prod.rating = info.rating || prod.rating;
                    prod.reviews = info.reviews_cnt || prod.reviews;
                }
            }
        } catch (e) {}
    }

    // Merge SKU data
    for (const resp of captured.skuResps) {
        try {
            const json = JSON.parse(resp);
            const items = json.data?.items || json.data?.data || [];
            if (items.length > 0) {
                const pid = items[0].meta?.product_id;
                const prod = output.products.find(p => p.product_id === pid);
                if (prod) {
                    for (const item of items) {
                        const sku = {
                            sku_id: item.meta.sku_id,
                            sku_property: item.meta.sku_property_value || '',
                            gmv: parseFloat(item.stats?.sku_gmv?.amount) || 0,
                            orders: item.stats?.sku_order_cnt || 0,
                            units_sold: item.stats?.sku_unit_sold_cnt || 0,
                            stock_status: item.stats?.sku_stock_status || item.meta.sku_stock_status || ''
                        };
                        prod.skus.push(sku);
                    }
                }
            }
        } catch (e) {}
    }

    // Aggregate by category
    for (const p of output.products) {
        const cat = p.category_name || p.category_lvl1;
        if (!output.categories[cat]) output.categories[cat] = { products: 0, gmv: 0, orders: 0 };
        output.categories[cat].products++;
        output.categories[cat].gmv += p.gmv_7d;
        output.categories[cat].orders += p.orders_7d;
    }

    // Save
    const outPath = path.join(__dirname, 'products_' + today + '.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`\n[SAVED] ${outPath}`);

    // Print summary
    console.log(`\n========== 商品数据分析报告 ==========`);
    console.log(`采集日期: ${today}`);
    console.log(`商品总数: ${output.total_products}`);
    
    console.log(`\n--- 类目分布 ---`);
    for (const [cat, data] of Object.entries(output.categories)) {
        console.log(`  ${cat}: ${data.products}个商品, RM${data.gmv.toFixed(2)}, ${data.orders}单`);
    }
    
    console.log(`\n--- 商品详情 ---`);
    for (const p of output.products) {
        console.log(`  ${p.product_name.substring(0, 45).padEnd(47)} | GMV RM${String(p.gmv_7d.toFixed(2)).padStart(10)} | ${String(p.orders_7d).padStart(3)}单 | ${p.skus.length}个SKU`);
    }

    // Note about subcategory
    console.log(`\n⚠️ 注意：目前只采集到一级类目"Bayi & Materniti"`);
    console.log(`   子类目（如纸尿裤/湿巾/卫生巾）需要从商品管理页面获取`);
    console.log(`   如需更细的子类目拆分，我可以进一步去商品管理页面采集`);

    await cdp.detach();
    await browser.disconnect();
    console.log('\n[DONE]');
})().catch(e => { console.error('[ERROR]', e.message); process.exit(1); });
