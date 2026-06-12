const puppeteer = require('puppeteer-core');
const http = require('http');
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

    const cdpSession = await page.target().createCDPSession();
    await cdpSession.send('Network.enable');

    const pendingRequests = new Map();
    let payload = null;

    cdpSession.on('Network.requestWillBeSent', (event) => {
        const url = event.request.url;
        if (url.includes('us_shop_rank_list')) {
            console.log('[REQ] rank_list requestId=' + event.requestId);
            pendingRequests.set(event.requestId, url);
            
            // Try to get post data via CDP API
            cdpSession.send('Network.getRequestPostData', {
                requestId: event.requestId
            }).then(result => {
                if (result.postData) {
                    console.log('[BODY] CAPTURED!');
                    payload = result.postData;
                }
            }).catch(e => {
                // Body not available yet, try on loading finished
            });
        }
    });

    cdpSession.on('Network.loadingFinished', async (event) => {
        if (pendingRequests.has(event.requestId)) {
            console.log('[DONE] requestId=' + event.requestId);
            
            // Try to get post data now that loading is finished
            if (!payload) {
                try {
                    const result = await cdpSession.send('Network.getRequestPostData', {
                        requestId: event.requestId
                    });
                    if (result.postData) {
                        console.log('[BODY] GOT IT AFTER LOAD!');
                        payload = result.postData;
                    }
                } catch(e) {
                    console.log('[BODY] Still not available:', e.message.substring(0, 100));
                }
            }
            
            // Get response body too
            try {
                const resp = await cdpSession.send('Network.getResponseBody', {
                    requestId: event.requestId
                });
                const body = resp.base64Encoded 
                    ? Buffer.from(resp.body, 'base64').toString('utf8')
                    : resp.body;
                try {
                    const json = JSON.parse(body);
                    const d = json.data?.[0];
                    if (d?.intervals?.[0]?.rows) {
                        console.log(`[RESP] ${d.intervals[0].rows.length} rows, total=${d.next_page?.total_result_count}`);
                    }
                } catch(e) {
                    console.log('[RESP] Could not parse JSON');
                }
            } catch(e) {}
            
            pendingRequests.delete(event.requestId);
        }
    });

    console.log('[NAV] Loading Compass...');
    await page.goto('https://seller-my.tiktok.com/compass/data-overview?shop_region=MY&lang=en', {
        waitUntil: 'networkidle0', timeout: 60000
    });
    await new Promise(r => setTimeout(r, 5000));

    if (payload) {
        console.log('\n=== PAYLOAD ===');
        try {
            const parsed = JSON.parse(payload);
            console.log(JSON.stringify(parsed, null, 2));
            
            // Now use this payload to test pagination
            console.log('\n=== PAGINATION TEST ===');
            for (const tc of [{size: 100, page: 1}, {size: 50, page: 5}, {size: 10, page: 2}]) {
                const modified = JSON.parse(JSON.stringify(parsed));
                modified.common_req.page = { page_size: tc.size, page_num: tc.page };
                
                // Fetch from within the browser context using the captured URL
                const storedUrl = Array.from(pendingRequests.keys())[0] || '';
            }
        } catch(e) {
            console.log('Raw:', payload.substring(0, 1000));
        }
    } else {
        console.log('\n=== NO PAYLOAD CAPTURED ===');
        console.log('CDP getRequestPostData returned null. TikTok might use streaming fetch.');
        console.log('Known API structure from response:');
        console.log('- dimension_id: 1043');
        console.log('- time_range: { granularity: "day", scenario: 0, timezone_offset: 480 }');
        console.log('- page: { page_size: 10, page_num: 1 }');
        console.log('- Endpoint: /api/v2/insights/seller/unified/query/us_shop_rank_list');
        console.log('- Total: 3968 shops across 397 pages');
    }

    await cdpSession.detach();
    await browser.disconnect();
    console.log('\n[DONE]');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
