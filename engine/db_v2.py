"""
tkads - db_v2.py
Upgraded operation_log with Spec → Action → Result audit trail (SDD-inspired).
Coexists with the original db.py — does NOT modify ads.db or the old table.
Database: ~/.tkads/data/analytics.db
"""

import sqlite3
import os
import json
import time
from datetime import datetime

DB_PATH = os.path.expanduser('~/.tkads/data/analytics.db')

# ─── helpers ──────────────────────────────────────────────────────────────

def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _now():
    """ISO-8601 timestamp for SQLite."""
    return datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')


# ─── Schema ───────────────────────────────────────────────────────────────

V2_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS operation_log_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Spec (what was intended)
    operation TEXT NOT NULL,           -- 'create_ad', 'pause_ad', 'update_roi', etc.
    namespace TEXT DEFAULT 'tkads',    -- 'tkads.ad', 'tkads.collect', 'tkads.monitor'
    store_id TEXT DEFAULT 'hanmac',    -- which store
    campaign_id TEXT,                  -- campaign_id if applicable

    -- Plan (what was expected)
    expected_roi REAL,                 -- target ROI (for update/create)
    expected_budget REAL,              -- target budget
    expected_result TEXT,              -- human description of expected outcome

    -- Action (what was done)
    request_body TEXT,                 -- full API request body (JSON)
    response_body TEXT,                -- full API response (JSON)

    -- Result (what actually happened)
    status TEXT DEFAULT 'OK',          -- 'OK', 'BLOCKED', 'ERROR', 'TIMEOUT'
    actual_result TEXT,                -- actual outcome description
    deviation TEXT,                    -- what differed from expected

    -- Audit
    gate_results TEXT,                 -- JSON of gate check results (if applicable)
    error_message TEXT,                -- error message if failed
    duration_ms INTEGER,              -- how long it took
    tkads_version TEXT DEFAULT '3.0',  -- version tracking
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
"""

V2_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_ologv2_operation ON operation_log_v2(operation)",
    "CREATE INDEX IF NOT EXISTS idx_ologv2_status    ON operation_log_v2(status)",
    "CREATE INDEX IF NOT EXISTS idx_ologv2_namespace ON operation_log_v2(namespace)",
    "CREATE INDEX IF NOT EXISTS idx_ologv2_store     ON operation_log_v2(store_id)",
    "CREATE INDEX IF NOT EXISTS idx_ologv2_campaign  ON operation_log_v2(campaign_id)",
    "CREATE INDEX IF NOT EXISTS idx_ologv2_created   ON operation_log_v2(created_at)",
]


# ─── V2 table management ──────────────────────────────────────────────────

def migrate_operation_log():
    """
    Create the V2 operation_log_v2 table if it doesn't exist.
    Optionally migrates data from the old operation_log table (analytics.db).
    Returns dict with counts of rows created / migrated.
    """
    result = {"table_created": False, "rows_migrated": 0}

    with get_conn() as conn:
        # 1. Create the V2 table
        conn.execute(V2_TABLE_DDL)
        for idx in V2_INDEXES:
            conn.execute(idx)
        result["table_created"] = True

        # 2. Check if the old operation_log table exists and has data
        old_exists = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='operation_log'"
        ).fetchone()

        if old_exists:
            # Discover actual columns of the old table
            pragma = conn.execute("PRAGMA table_info(operation_log)").fetchall()
            old_cols = {row['name'] for row in pragma}

            # Check if v2 table has any data already
            existing = conn.execute("SELECT COUNT(*) AS c FROM operation_log_v2").fetchone()
            if existing and existing['c'] > 0:
                result["rows_migrated"] = 0  # already migrated
                return result

            # Build INSERT based on what columns exist in the old table
            # Common old schemas seen:
            #   (id, timestamp, action_type, target, detail)  ← analytics.db
            #   (id, operation, campaign_id, details, status, created_at)  ← task description
            #   (id, timestamp, action_type, campaign_id, params, result, notes)  ← ads.db

            inserted = 0

            if {'action_type', 'target', 'detail'} <= old_cols:
                # analytics.db style: timestamp, action_type, target, detail
                rows = conn.execute(
                    "SELECT timestamp, action_type, target, detail FROM operation_log ORDER BY timestamp"
                ).fetchall()
                for r in rows:
                    detail_str = r['detail'] or ''
                    target_str = r['target'] or ''
                    action = r['action_type'] or 'unknown'

                    # Try to parse detail as JSON for richer migration
                    extra = {}
                    try:
                        extra = json.loads(detail_str) if detail_str else {}
                    except (json.JSONDecodeError, TypeError):
                        extra = {}

                    conn.execute(
                        """INSERT INTO operation_log_v2
                           (operation, namespace, store_id, campaign_id,
                            expected_result, actual_result, deviation,
                            request_body, response_body, status,
                            gate_results, error_message, duration_ms,
                            created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        [
                            action,
                            extra.get('namespace', 'tkads'),
                            extra.get('store_id', 'hanmac'),
                            target_str or extra.get('campaign_id'),
                            extra.get('expected_result'),
                            extra.get('actual_result') or detail_str,
                            extra.get('deviation'),
                            extra.get('request_body'),
                            extra.get('response_body'),
                            extra.get('status', 'OK'),
                            extra.get('gate_results'),
                            extra.get('error_message'),
                            extra.get('duration_ms'),
                            r['timestamp'],
                        ]
                    )
                    inserted += 1

            elif {'operation', 'details'} <= old_cols:
                # Task-description style: operation, campaign_id, details, status, created_at
                rows = conn.execute(
                    "SELECT operation, campaign_id, details, status, created_at FROM operation_log ORDER BY created_at"
                ).fetchall()
                for r in rows:
                    details_str = r['details'] or ''
                    extra = {}
                    try:
                        extra = json.loads(details_str) if details_str else {}
                    except (json.JSONDecodeError, TypeError):
                        extra = {}

                    conn.execute(
                        """INSERT INTO operation_log_v2
                           (operation, namespace, store_id, campaign_id,
                            expected_result, actual_result, deviation,
                            request_body, response_body, status,
                            gate_results, error_message, duration_ms,
                            created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        [
                            r['operation'],
                            extra.get('namespace', 'tkads'),
                            extra.get('store_id', 'hanmac'),
                            r['campaign_id'],
                            extra.get('expected_result'),
                            extra.get('actual_result') or details_str,
                            extra.get('deviation'),
                            extra.get('request_body'),
                            extra.get('response_body'),
                            r['status'] or 'OK',
                            extra.get('gate_results'),
                            extra.get('error_message'),
                            extra.get('duration_ms'),
                            r['created_at'],
                        ]
                    )
                    inserted += 1

            elif {'action_type', 'params'} <= old_cols or {'action_type'} <= old_cols:
                # ads.db style: action_type, campaign_id, params, result, notes
                rows = conn.execute(
                    "SELECT action_type, campaign_id, params, result, notes, timestamp FROM operation_log ORDER BY timestamp"
                ).fetchall()
                for r in rows:
                    action = r['action_type'] or 'unknown'
                    params_str = r['params'] or '{}'
                    result_str = r['result'] or ''
                    extra = {}
                    try:
                        extra = json.loads(params_str) if params_str else {}
                    except (json.JSONDecodeError, TypeError):
                        extra = {}

                    conn.execute(
                        """INSERT INTO operation_log_v2
                           (operation, namespace, store_id, campaign_id,
                            expected_result, actual_result, deviation,
                            request_body, response_body, status,
                            gate_results, error_message, duration_ms,
                            created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        [
                            action,
                            extra.get('namespace', 'tkads'),
                            extra.get('store_id', 'hanmac'),
                            r['campaign_id'],
                            extra.get('expected_result') or params_str,
                            extra.get('actual_result') or result_str,
                            extra.get('deviation'),
                            extra.get('request_body'),
                            extra.get('response_body'),
                            extra.get('status', 'OK'),
                            extra.get('gate_results'),
                            extra.get('error_message'),
                            extra.get('duration_ms'),
                            r['timestamp'],
                        ]
                    )
                    inserted += 1

            result["rows_migrated"] = inserted

    return result


# ─── Logging ──────────────────────────────────────────────────────────────

def log_operation_v2(
    operation,
    namespace='tkads',
    store_id='hanmac',
    campaign_id=None,
    expected_roi=None,
    expected_budget=None,
    expected_result=None,
    request_body=None,
    response_body=None,
    status='OK',
    actual_result=None,
    deviation=None,
    gate_results=None,
    error_message=None,
    duration_ms=None,
):
    """
    Insert a single row into operation_log_v2.
    All JSON-ish parameters are auto-serialised if they are dicts/lists.
    """
    def _json(val):
        if val is None:
            return None
        if isinstance(val, (dict, list)):
            return json.dumps(val, ensure_ascii=False, default=str)
        return str(val)

    with get_conn() as conn:
        conn.execute(
            """INSERT INTO operation_log_v2
               (operation, namespace, store_id, campaign_id,
                expected_roi, expected_budget, expected_result,
                request_body, response_body,
                status, actual_result, deviation,
                gate_results, error_message, duration_ms,
                created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                operation,
                namespace,
                store_id,
                campaign_id,
                expected_roi,
                expected_budget,
                expected_result,
                _json(request_body),
                _json(response_body),
                status,
                actual_result,
                deviation,
                _json(gate_results),
                error_message,
                duration_ms,
                _now(),
            ]
        )


# ─── Backward compatibility ───────────────────────────────────────────────

def log_operation(action_type, campaign_id=None, params=None, result=None, notes=None):
    """
    Drop-in backward-compatible wrapper for the old db.log_operation() signature
    (from ads.db style). Logs to the V2 table with sensible defaults.
    """
    # Convert old-style params to structured form
    if isinstance(params, str):
        try:
            params = json.loads(params)
        except (json.JSONDecodeError, TypeError):
            params = {'raw': params}

    if isinstance(result, str):
        try:
            result = json.loads(result)
        except (json.JSONDecodeError, TypeError):
            result = {'raw': result}

    expected_result = None
    actual_result = None
    deviation_text = None
    request_body = None
    response_body = None
    error_msg = None

    if params and isinstance(params, dict):
        expected_result = params.get('expected_result') or json.dumps(params, ensure_ascii=False)
        request_body = params.get('request_body') or json.dumps(params, ensure_ascii=False)
    else:
        expected_result = json.dumps(params) if params else None

    if result and isinstance(result, dict):
        actual_result = result.get('actual_result') or json.dumps(result, ensure_ascii=False)
        response_body = result.get('response_body') or json.dumps(result, ensure_ascii=False)
        deviation_text = result.get('deviation')
        error_msg = result.get('error_message') or result.get('error')
    else:
        actual_result = json.dumps(result) if result else None

    # Determine status
    status = 'OK'
    if error_msg:
        status = 'ERROR'
    elif result and isinstance(result, dict):
        status = result.get('status', 'OK')

    with get_conn() as conn:
        conn.execute(
            """INSERT INTO operation_log_v2
               (operation, namespace, store_id, campaign_id,
                expected_result, actual_result, deviation,
                request_body, response_body, status,
                error_message, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                action_type,
                'tkads',
                'hanmac',
                campaign_id,
                expected_result,
                actual_result,
                deviation_text,
                request_body,
                response_body,
                status,
                error_msg or notes,
                _now(),
            ]
        )


# ─── Querying ─────────────────────────────────────────────────────────────

def query_operations(limit=50, operation=None, status=None):
    """
    Query operation_log_v2 with optional filters.
    Returns list of dicts ordered by created_at DESC.
    """
    clauses = []
    params = []

    if operation:
        clauses.append("operation = ?")
        params.append(operation)

    if status:
        clauses.append("status = ?")
        params.append(status)

    where = ""
    if clauses:
        where = "WHERE " + " AND ".join(clauses)

    sql = f"SELECT * FROM operation_log_v2 {where} ORDER BY created_at DESC LIMIT ?"
    params.append(limit)

    with get_conn() as conn:
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]


def get_operation_stats():
    """
    Returns summary stats from operation_log_v2 as a dict:
      - total: total row count
      - by_operation: dict {operation_name: count}
      - by_status: dict {status_name: count}
      - recent_counts: last-7-days counts by operation
    """
    with get_conn() as conn:
        total = conn.execute("SELECT COUNT(*) AS c FROM operation_log_v2").fetchone()['c']

        by_operation = {}
        rows = conn.execute(
            "SELECT operation, COUNT(*) AS c FROM operation_log_v2 GROUP BY operation ORDER BY c DESC"
        ).fetchall()
        for r in rows:
            by_operation[r['operation']] = r['c']

        by_status = {}
        rows = conn.execute(
            "SELECT status, COUNT(*) AS c FROM operation_log_v2 GROUP BY status ORDER BY c DESC"
        ).fetchall()
        for r in rows:
            by_status[r['status']] = r['c']

        recent = {}
        rows = conn.execute(
            """SELECT operation, COUNT(*) AS c FROM operation_log_v2
               WHERE created_at >= datetime('now', '-7 days')
               GROUP BY operation ORDER BY c DESC"""
        ).fetchall()
        for r in rows:
            recent[r['operation']] = r['c']

    return {
        "total": total,
        "by_operation": by_operation,
        "by_status": by_status,
        "recent_7d": recent,
    }


# ─── Auto-migrate on import ───────────────────────────────────────────────

_initialised = False

def _auto_init():
    global _initialised
    if not _initialised:
        migrate_operation_log()
        _initialised = True

_auto_init()
