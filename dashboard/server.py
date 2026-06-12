"""
Hanmac Dashboard - Backend API (PostgreSQL version)
"""
import json
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
import psycopg2
import psycopg2.extras

from db_config import DATABASE_URL

app = FastAPI(title="Hanmac Dashboard")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

BASE = Path(__file__).parent.parent  # hermes-home/

def get_db():
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = True
    return conn

def query(sql, params=None):
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(sql, params or ())
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return [dict(r) for r in rows]

def scalar(sql, params=None):
    conn = get_db()
    cur = conn.cursor()
    cur.execute(sql, params or ())
    val = cur.fetchone()
    cur.close()
    conn.close()
    return val[0] if val else None

# ─── API ─────────────────────────────────────────────

@app.get("/api/overview")
def get_overview():
    """Dashboard overview"""
    # Latest content breakdown
    cd = query("SELECT * FROM content_daily ORDER BY date DESC LIMIT 1")
    cd = cd[0] if cd else {}
    
    # Products 7d totals
    prod = query("""
        SELECT COALESCE(SUM(gmv_7d),0) as gmv_7d, 
               COALESCE(SUM(orders_7d),0) as orders_7d,
               COUNT(*) as products_count
        FROM products WHERE collect_date = (SELECT MAX(collect_date) FROM products)
    """)
    prod = prod[0] if prod else {}
    
    # Shop rankings - our shop
    my_shop = query("""
        SELECT rank, pay_amt, pay_amt_rank_diff, shop_name
        FROM shop_rankings 
        WHERE shop_name LIKE '%Hanmac%' AND collect_date = (SELECT MAX(collect_date) FROM shop_rankings)
        LIMIT 1
    """)
    my_shop = my_shop[0] if my_shop else {}
    
    return {
        "code": 200,
        "data": {
            "date": str(cd.get("date", "")),
            "gmv_today": float(cd.get("total_gmv", 0)),
            "orders_today": int(cd.get("total_orders", 0)),
            "customers_today": int(cd.get("total_customers", 0)),
            "gmv_7d": float(prod.get("gmv_7d", 0)),
            "orders_7d": int(prod.get("orders_7d", 0)),
            "products_count": int(prod.get("products_count", 0)),
            "my_shop_rank": int(my_shop.get("rank", 0)) if my_shop else None,
            "my_shop_gmv": float(my_shop.get("pay_amt", 0)) if my_shop else 0,
            "my_shop_name": my_shop.get("shop_name", "") if my_shop else "",
            "content_breakdown": {
                "live": {
                    "gmv": float(cd.get("live_gmv", 0)),
                    "direct_gmv": float(cd.get("live_direct", 0)),
                    "indirect_gmv": float(cd.get("live_indirect", 0)),
                    "affiliate_gmv": float(cd.get("live_affiliate", 0)),
                    "seller_gmv": float(cd.get("live_seller", 0)),
                },
                "video": {
                    "gmv": float(cd.get("video_gmv", 0)),
                    "direct_gmv": float(cd.get("video_direct", 0)),
                    "indirect_gmv": float(cd.get("video_indirect", 0)),
                    "affiliate_gmv": float(cd.get("video_affiliate", 0)),
                    "seller_gmv": float(cd.get("video_seller", 0)),
                },
                "product_card": {
                    "gmv": float(cd.get("product_card_gmv", 0)),
                    "affiliate_gmv": float(cd.get("product_card_affiliate", 0)),
                    "seller_gmv": float(cd.get("product_card_seller", 0)),
                }
            },
            "daily_metrics": {
                "gmv": float(cd.get("total_gmv", 0)),
                "orders": int(cd.get("total_orders", 0)),
                "customers": int(cd.get("total_customers", 0)),
                "visitors": int(cd.get("visitors", 0)),
                "impressions": int(cd.get("impressions", 0)),
            }
        }
    }

@app.get("/api/products")
def get_products(sort: str = "gmv", order: str = "desc", limit: int = 50):
    """Product ranking"""
    sort_field = {
        "gmv": "gmv_7d", "orders": "orders_7d",
        "impressions": "impressions_pv_7d", "ctr": "ctr_pv_7d"
    }.get(sort, "gmv_7d")
    dir = "DESC" if order.lower() != "asc" else "ASC"
    
    products = query(f"""
        SELECT p.*, 
               COALESCE(jsonb_agg(jsonb_build_object('date',pd.date,'gmv',pd.gmv,'orders',pd.orders) ORDER BY pd.date) FILTER (WHERE pd.id IS NOT NULL), '[]') as daily_data
        FROM products p
        LEFT JOIN products_daily pd ON p.product_id = pd.product_id
        WHERE p.collect_date = (SELECT MAX(collect_date) FROM products)
        GROUP BY p.id
        ORDER BY {sort_field} {dir}
        LIMIT %s
    """, (limit,))
    
    # Add gmv_daily as simple dict
    for p in products:
        daily = {}
        for d in p.get("daily_data", []):
            daily[str(d["date"])] = float(d.get("gmv", 0))
        p["gmv_daily"] = daily
        p["daily_dates"] = list(daily.keys())
        del p["daily_data"]
        # Format fields
        p["gmv_7d"] = float(p.get("gmv_7d", 0))
        p["ctr_pv_7d"] = float(p.get("ctr_pv_7d", 0))
    
    return {
        "code": 200,
        "data": {
            "list": products,
            "total": len(products),
        }
    }

@app.get("/api/shops")
def get_shops(sort: str = "pay_amt", order: str = "desc", limit: int = 50):
    """Shop ranking"""
    sort_field = {
        "pay_amt": "pay_amt", "video": "video_pay_amt",
        "live": "live_pay_amt", "product_card": "product_card_pay_amt"
    }.get(sort, "pay_amt")
    dir = "DESC" if order.lower() != "asc" else "ASC"
    
    shops = query(f"""
        SELECT * FROM shop_rankings
        WHERE collect_date = (SELECT MAX(collect_date) FROM shop_rankings)
        ORDER BY {sort_field} {dir}
        LIMIT %s
    """, (limit,))
    
    for s in shops:
        for k in ['pay_amt','video_pay_amt','live_pay_amt','product_card_pay_amt']:
            if s.get(k) is not None:
                s[k] = float(s[k])
    
    return {
        "code": 200,
        "data": {
            "list": shops,
            "total": len(shops),
            "date": str(shops[0].get("collect_date")) if shops else None,
        }
    }

@app.get("/api/content-breakdown")
def get_content_breakdown():
    rows = query("SELECT * FROM content_daily ORDER BY date DESC")
    return {"code": 200, "data": rows}

@app.get("/api/creators")
def get_creators():
    return {"code": 200, "data": {"list": [], "total": 0}}

@app.get("/api/videos")
def get_videos():
    return {"code": 200, "data": {"list": [], "total": 0}}

@app.get("/")
def index():
    return FileResponse(str(BASE / "dashboard" / "index.html"))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8081, log_level="info")
