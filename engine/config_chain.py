#!/usr/bin/env python3
"""
config_chain.py — Python counterpart of config-chain.js

Reads ~/.tkads/stores.json and provides layered config resolution
with environment variable overrides (TKADS_ prefix).

Priority: env override → store config → built-in defaults.

Usage:
    from config_chain import config
    sid = config.get('sid')
    store = config.get_store('hanmac')
    stores = config.list_stores()
"""

import json
import os
import time
from pathlib import Path

# ─── Defaults ──────────────────────────────────────────────────────────────────

TKADS_DIR = Path.home() / '.tkads'
STORES_JSON_PATH = TKADS_DIR / 'stores.json'

BUILTIN_DEFAULTS = {
    # From collect_day_by_day.py / api.py / daily-collect.py / daily-report.py
    'shop_name': 'Hanmac.my',
    'sid': '7494105016200037977',
    'advid': '7569565674088136705',
    'aadvid': '7569565674088136705',
    'profile_id': 'k1456ta2',
    'seller_domain': 'seller-my.tiktok.com',
    'tid': '7494105046161482189',
    'ads_url': 'http://local.adspower.net:50325',
    'shop_id': '7494105016200037977',
    'bc_id': '7545376144372318224',
    'creator_uid': '7550180591812412432',
    'country': 'MY',
    'currency': 'USD',
    'timezone': 'Asia/Shanghai',
    'budget': 20,
    'roi_target': 1.2,
    'base_url': 'https://open-api.tiktokglobalshop.com',
    'custom_props': {},
}

DEFAULT_STORE_ID = 'default'

# ─── Helpers ───────────────────────────────────────────────────────────────────


def _deep_merge(target, *sources):
    """Lightweight deep-merge: copies dict props from sources onto target."""
    for src in sources:
        if not isinstance(src, dict):
            continue
        for key, val in src.items():
            if isinstance(val, dict) and isinstance(target.get(key), dict):
                target[key] = _deep_merge(target[key], val)
            else:
                target[key] = val
    return target


def _env_override(key):
    """Read an env override for `key` using TKADS_ prefix.

    Returns the string value if set, None otherwise.
    Supports both TKADS_SID and TKADS_AADVID (matching JS convention).
    The env key is 'TKADS_' + uppercased key.
    """
    env_key = 'TKADS_' + key.upper()
    val = os.environ.get(env_key)
    return val


# ─── ConfigChain ───────────────────────────────────────────────────────────────


class ConfigChain:
    """Layered configuration: environment variables → stores.json → built-in defaults.

    Caches parsed stores.json on first read and refreshes when mtime changes.
    """

    def __init__(self, file_path=None, defaults=None):
        self._file_path = Path(file_path or STORES_JSON_PATH)
        self._defaults = dict(BUILTIN_DEFAULTS)
        if defaults:
            self._defaults.update(defaults)

        # Cache: {mtime: float, data: dict}
        self._cache = None

    # ── private helpers ──────────────────────────────────────────────────────

    def _load_raw(self):
        """Read and parse stores.json with graceful fallback."""
        fpath = self._file_path
        try:
            mtime = fpath.stat().st_mtime_ns
            if self._cache is not None and self._cache['mtime'] == mtime:
                return self._cache['data']

            raw = fpath.read_text(encoding='utf-8')
            data = json.loads(raw)
            self._cache = {'mtime': mtime, 'data': data}
            return data
        except (FileNotFoundError, json.JSONDecodeError) as exc:
            # File doesn't exist or is malformed — return sensible fallback shape.
            is_missing = isinstance(exc, FileNotFoundError)
            fallback = {
                'active_store': DEFAULT_STORE_ID,
                'stores': {
                    DEFAULT_STORE_ID: {},
                },
            }
            # Best-effort: ensure parent dir exists and write fallback if missing.
            if is_missing:
                try:
                    fpath.parent.mkdir(parents=True, exist_ok=True)
                    fpath.write_text(
                        json.dumps(fallback, indent=2, ensure_ascii=False),
                        encoding='utf-8',
                    )
                except OSError:
                    pass  # best-effort
            self._cache = {'mtime': time.time_ns(), 'data': fallback}
            return fallback
        except (OSError, PermissionError):
            # Permissions or other I/O errors — return empty shape.
            return {'active_store': DEFAULT_STORE_ID, 'stores': {}}

    def _resolve_store_id(self, store_id=None):
        """Resolve the effective store ID from argument → env → config file."""
        if store_id:
            return store_id
        env_store = os.environ.get('TKADS_STORE')
        if env_store:
            return env_store
        raw = self._load_raw()
        return raw.get('active_store', DEFAULT_STORE_ID)

    def _get_store_raw(self, store_id=None):
        """Return raw store config dict (or None if not found)."""
        raw = self._load_raw()
        sid = self._resolve_store_id(store_id)
        stores = raw.get('stores', {})
        return stores.get(sid)

    # ── public API ───────────────────────────────────────────────────────────

    def get(self, key, store_id=None):
        """Get a resolved config value.

        Priority: env override → store config → built-in defaults.
        Supports dot-separated keys (e.g. 'custom_props.foo').

        Args:
            key: Config key to look up (e.g. 'sid', 'profile_id').
            store_id: Optional explicit store ID. Uses active_store if omitted.

        Returns:
            Resolved value, or None if not found anywhere.
        """
        if not isinstance(key, str) or not key.strip():
            return None

        key = key.strip()

        # 1. Env override
        env_val = _env_override(key)
        if env_val is not None:
            return env_val

        # 2. Store config (with dot-key traversal)
        store = self._get_store_raw(store_id)
        if store is not None:
            parts = key.split('.')
            cursor = store
            for part in parts:
                if not isinstance(cursor, dict):
                    cursor = None
                    break
                cursor = cursor.get(part)
            if cursor is not None:
                return cursor

        # 3. Fallback: try the first available store if no explicit store_id
        if not store_id:
            raw = self._load_raw()
            stores = raw.get('stores', {})
            first_id = next(iter(stores), None)
            if first_id and first_id != self._resolve_store_id(store_id):
                first_store = stores[first_id]
                if isinstance(first_store, dict):
                    parts = key.split('.')
                    cursor = first_store
                    for part in parts:
                        if not isinstance(cursor, dict):
                            cursor = None
                            break
                        cursor = cursor.get(part)
                    if cursor is not None:
                        return cursor

        # 4. Built-in defaults (with dot-key traversal)
        parts = key.split('.')
        cursor = self._defaults
        for part in parts:
            if not isinstance(cursor, dict):
                return None
            cursor = cursor.get(part)
        return cursor

    def get_all(self, store_id=None):
        """Get all resolved config for a store as a merged dict.

        Priority: env override → store config → built-in defaults.
        Also picks up any TKADS_* env vars not in defaults.

        Args:
            store_id: Optional explicit store ID.

        Returns:
            Merged dict with all resolved values.
        """
        store = self._get_store_raw(store_id) or {}
        merged = _deep_merge({}, self._defaults, store)

        # Apply env overrides for every known default key.
        for key in self._defaults:
            env_val = _env_override(key)
            if env_val is not None:
                merged[key] = env_val

        # Also scan for TKADS_ prefixed keys not in defaults.
        for env_key, env_val in os.environ.items():
            if env_key.startswith('TKADS_'):
                config_key = env_key[6:].lower()
                if config_key not in self._defaults:
                    merged[config_key] = env_val

        return merged

    def get_store(self, store_id=None):
        """Get the raw store config dict (no env overrides, no defaults merged).

        Args:
            store_id: Optional explicit store ID. Uses active_store if omitted.

        Returns:
            Store config dict, or None if the store doesn't exist.
        """
        return self._get_store_raw(store_id)

    def list_stores(self):
        """List all store IDs present in stores.json.

        Returns:
            List of store ID strings.
        """
        raw = self._load_raw()
        stores = raw.get('stores', {})
        return list(stores.keys())

    def refresh(self):
        """Force refresh the cache on next access."""
        self._cache = None


# ─── Singleton instance ───────────────────────────────────────────────────────

config = ConfigChain()

# Also export the class for advanced usage.
__all__ = ['ConfigChain', 'config', 'BUILTIN_DEFAULTS', 'DEFAULT_STORE_ID']
