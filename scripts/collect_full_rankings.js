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

    // Find existing compass tab
    let pages = await browser.pages();
    let page = pages.find(p => p.url().includes('compass/data-overview'));
    
    if (!page) {
        console.log('[NAV] No compass tab found, navigating...');
        page = await browser.newPage();
        await page.goto('https://seller-my.tiktok.com/compass/data-overview?shop_region=MY&lang=en', {
            waitUntil: 'networkidle0', timeout: 60000
        });
    } else {
        console.log('[OK] Found existing compass tab');
    }

    const cdpSession = await page.target().createCDPSession();
    await cdpSession.send('Network.enable');

    // Capture payload and URL
    let basePayload = null;
    let baseUrl = '';

    cdpSession.on('Network.requestWillBeSent', (event) => {
        const url = event.request.url;
        if (url.includes('us_shop_rank_list') && !baseUrl) {
            baseUrl = url;
            cdpSession.send('Network.getRequestPostData', { requestId: event.requestId })
                .then(result => { if (result.postData && !basePayload) basePayload = result.postData; })
                .catch(() => {});
        }
    });

    console.log('[NAV] Reloading to capture API payload...');
    await page.reload({ waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    if (!basePayload || !baseUrl) {
        console.log('[ERROR] Could not capture payload/URL');
        await browser.disconnect();
        process.exit(1);
    }

    const parsedPayload = JSON.parse(basePayload);
    console.log(`[OK] Payload captured | Total: 3,968 shops across 397 pages`);

    // Collect all data
    const PAGE_SIZE = 50;
    const TOTAL_PAGES = Math.ceil(3968 / PAGE_SIZE);
    const today = new Date().toISOString().split('T')[0];
    const allRows = [];

    for (let pageNum = 1; pageNum <= TOTAL_PAGES; pageNum++) {
        const body = JSON.parse(JSON.stringify(parsedPayload));
        body.query_condition[0].page = { size: PAGE_SIZE, page_number: pageNum };

        const result = await page.evaluate(async (args) => {
            const resp = await fetch(args.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: args.body
            });
            const text = await resp.text();
            let d;
            try { d = JSON.parse(text); } catch (e) { return { error: text.substring(0, 200) }; }

            if (d.data?.[0]?.intervals?.[0]?.rows) {
                const rows = d.data[0].intervals[0].rows;
                return {
                    rows: rows.map(r => ({
                        rank: parseInt(r.values.pay_amt_rank),
                        shop_name: JSON.parse(r.values.shop_meta || '{}').shop_name,
                        shop_id: r.values.shop_id || '',
                        pay_amt: parseFloat(r.values.pay_amt) || 0,
                        video_pay_amt: parseFloat(r.values.video_pay_amt) || 0,
                        live_pay_amt: parseFloat(r.values.live_pay_amt) || 0,
                        product_card_pay_amt: parseFloat(r.values.product_card_pay_amt) || 0,
                        rank_diff: r.values.pay_amt_rank_diff || '',
                        shop_status: JSON.parse(r.values.shop_meta || '{}').shop_status || '',
                        pay_amt_rank_before: r.values.pay_amt_rank_before || '',
                        pay_amt_score: r.values.pay_amt_score || ''
                    }))
                };
            }
            return { error: 'no data', raw: JSON.stringify(d).substring(0, 200) };
        }, { url: baseUrl, body: JSON.stringify(body) });

        if (result.error) {
            console.log(`\n[PAGE ${pageNum}/${TOTAL_PAGES}] Error: ${result.error}`);
            continue;
        }

        allRows.push(...result.rows);
        const first = result.rows[0];
        const last = result.rows[result.rows.length - 1];
        const pct = (pageNum / TOTAL_PAGES * 100).toFixed(1);
        const bar = '█'.repeat(Math.round(pageNum / TOTAL_PAGES * 30)) + '░'.repeat(30 - Math.round(pageNum / TOTAL_PAGES * 30));
        process.stdout.write(`\r[${bar}] ${pct}% | Page ${pageNum}/${TOTAL_PAGES} | Ranks ${first.rank}-${last.rank} | ${allRows.length}/3968`);

        await new Promise(r => setTimeout(r, 150));
    }

    console.log(`\n\n[OK] Collected ${allRows.length} shops total`);

    // Save to JSON
    const outputPath = path.join(__dirname, 'rankings_' + today + '.json');
    fs.writeFileSync(outputPath, JSON.stringify({ date: today, total: allRows.length, data: allRows }, null, 2));
    console.log(`[OK] Saved to ${outputPath}`);

    // Find our shop
    const us = allRows.find(r => r.shop_name?.toLowerCase().includes('hanmac'));
    if (us) {
        console.log(`\n========== OUR POSITION ==========`);
        console.log(`#${us.rank} ${us.shop_name}`);
        console.log(`  Pay Amount:  RM ${us.pay_amt.toLocaleString()}`);
        console.log(`  Video:       RM ${us.video_pay_amt.toLocaleString()} (#${us.pay_amt_rank_before || '?'})`);
        console.log(`  Live:        RM ${us.live_pay_amt.toLocaleString()}`);
        console.log(`  ProductCard: RM ${us.product_card_pay_amt.toLocaleString()}`);
        console.log(`  Rank Change: ${us.rank_diff}`);

        console.log(`\n========== TOP 10 ==========`);
        for (const r of allRows.slice(0, 10)) {
            console.log(`#${r.rank} ${r.shop_name.padEnd(35)} RM ${r.pay_amt.toLocaleString().padStart(12)}`);
        }

        console.log(`\n========== SHOPS AROUND US (±5) ==========`);
        const idx = allRows.findIndex(r => r.shop_name?.toLowerCase().includes('hanmac'));
        const start = Math.max(0, idx - 5);
        const end = Math.min(allRows.length, idx + 6);
        for (let i = start; i < end; i++) {
            const r = allRows[i];
            const marker = r.shop_name?.toLowerCase().includes('hanmac') ? '  <<< ' : '';
            console.log(`#${r.rank} ${r.shop_name.padEnd(35)} RM ${r.pay_amt.toLocaleString().padStart(12)}${marker}`);
        }
    } else {
        console.log('\n[WARN] Hanmac not found in rankings');
    }

    // Also save as CSV for easy import
    const csvPath = path.join(__dirname, 'rankings_' + today + '.csv');
    const csvHeader = 'rank,shop_name,shop_id,pay_amt,video_pay_amt,live_pay_amt,product_card_pay_amt,rank_diff,shop_status\n';
    const csvRows = allRows.map(r =>
        `${r.rank},"${r.shop_name}",${r.shop_id},${r.pay_amt},${r.video_pay_amt},${r.live_pay_amt},${r.product_card_pay_amt},"${r.rank_diff}",${r.shop_status}`
    ).join('\n');
    fs.writeFileSync(csvPath, csvHeader + csvRows);
    console.log(`\n[OK] CSV saved to ${csvPath}`);

    // Save Python import script
    const pyScript = `
import sqlite3, csv, os
script_dir = os.path.dirname(os.path.abspath(__file__))
db_path = os.path.join(script_dir, 'analytics.db')
csv_path = os.path.join(script_dir, 'rankings_DATE_PLACEHOLDER.csv')
conn = sqlite3.connect(db_path)
c = conn.cursor()
c.execute("CREATE TABLE IF NOT EXISTS compass_rankings (id INTEGER PRIMARY KEY AUTOINCREMENT, collect_date TEXT, rank INTEGER, shop_name TEXT, shop_id TEXT, pay_amt REAL, video_pay_amt REAL, live_pay_amt REAL, product_card_pay_amt REAL, pay_amt_rank_diff TEXT, shop_status TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)")
c.execute("DELETE FROM compass_rankings WHERE collect_date = ?", ("DATE_PLACEHOLDER",))
with open(csv_path, 'r', encoding='utf-8') as f:
    for row in csv.DictReader(f):
        c.execute("INSERT INTO compass_rankings (collect_date, rank, shop_name, shop_id, pay_amt, video_pay_amt, live_pay_amt, product_card_pay_amt, pay_amt_rank_diff, shop_status) VALUES (?,?,?,?,?,?,?,?,?,?)",
                  ("DATE_PLACEHOLDER", int(row['rank']), row['shop_name'], row['shop_id'], float(row['pay_amt']), float(row['video_pay_amt']), float(row['live_pay_amt']), float(row['product_card_pay_amt']), row['rank_diff'], row['shop_status']))
conn.commit()
c.execute("SELECT COUNT(*) FROM compass_rankings WHERE collect_date = ?", ("DATE_PLACEHOLDER",))
print(f"Imported {c.fetchone()[0]} rows")
conn.close()
`.replace(/DATE_PLACEHOLDER/g, today);
    
    fs.writeFileSync(path.join(__dirname, '_import_rankings.py'), pyScript);
    console.log('[DB] Importing to analytics.db...');
    const { execSync } = require('child_process');
    try {
        const out = execSync('python scripts/_import_rankings.py', { cwd: __dirname, timeout: 15000 });
        console.log('[DB] ' + out.toString().trim());
    } catch (e) {
        console.log('[DB] Import error:', e.message.substring(0, 150));
        console.log('[DB] CSV saved, you can import manually with: python scripts/_import_rankings.py');
    }
    fs.unlinkSync(path.join(__dirname, '_import_rankings.py'));

    await cdpSession.detach();
    await browser.disconnect();
    console.log('\n========== COMPLETE ==========');
})().catch(e => {
    console.error('\n[ERROR]', e.message);
    process.exit(1);
});
