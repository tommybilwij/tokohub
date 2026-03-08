"""App settings stored in tokohub.app_settings (key-value)."""

from services.db import execute_query, execute_modify

# Defaults used when no DB row exists
_DEFAULTS = {
    'fuzzy_cache_ttl': '300',
    'fuzzy_top_n': '5',
    'fuzzy_min_score': '40',
    'pc_top_n': '10',
    'pc_min_score': '30',
    'po_top_n': '50',
    'po_min_score': '40',
    'session_max_age': '86400',
}

# In-memory cache (refreshed on get_all / save)
_cache: dict[str, str] = {}


async def get_all(pool) -> dict[str, str]:
    """Load all app_settings rows into a dict."""
    global _cache
    rows = await execute_query(pool, "SELECT `key`, `value` FROM tokohub.app_settings")
    result = dict(_DEFAULTS)
    for r in rows:
        result[r['key']] = r['value']
    _cache = dict(result)
    return result


async def get(pool, key: str) -> str:
    """Get a single setting value (from cache or DB)."""
    if not _cache:
        await get_all(pool)
    return _cache.get(key, _DEFAULTS.get(key, ''))


async def get_int(pool, key: str) -> int:
    """Get a single setting as int."""
    return int(await get(pool, key))


async def save_many(pool, data: dict[str, str]) -> None:
    """Upsert multiple settings."""
    global _cache
    for k, v in data.items():
        await execute_modify(
            pool,
            "INSERT INTO tokohub.app_settings (`key`, `value`) VALUES (%s, %s) "
            "ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
            (k, str(v)),
        )
    # Refresh cache
    await get_all(pool)
