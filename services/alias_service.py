"""CRUD operations for the tokohub.stock_alias table (async)."""

import logging
import re

from services.db import execute_query, execute_single, execute_modify

logger = logging.getLogger(__name__)


def normalize_alias(name):
    """Normalize an alias name for consistent lookup."""
    name = name.upper().strip()
    name = re.sub(r'[^\w\s]', ' ', name)
    name = re.sub(r'\s+', ' ', name)
    # Normalize common unit abbreviations
    for long, short in [('GRAM', 'G'), ('GR', 'G'), ('LITER', 'L'), ('LTR', 'L'),
                        ('MILI', 'ML'), ('KILO', 'KG')]:
        name = re.sub(rf'\b{long}\b', short, name)
    return name.strip()


async def find_by_alias(pool, name):
    """Look up an artno by alias name. Returns artno or None."""
    normalized = normalize_alias(name)
    try:   
        row = await execute_single(
            pool,
            "SELECT artno FROM tokohub.stock_alias WHERE alias_name = %s",
            (normalized,)
        )
        return row['artno'] if row else None
    except Exception:
        logger.debug("tokohub.stock_alias table not available, skipping alias lookup")
        return None


async def save_alias(pool, alias_name, artno, created_by='RECEIPT_APP'):
    """Save or update an alias mapping. Overwrites artno if alias already exists."""
    normalized = normalize_alias(alias_name)
    await execute_modify(
        pool,
        """INSERT INTO tokohub.stock_alias (alias_name, artno, created_by)
           VALUES (%s, %s, %s)
           ON DUPLICATE KEY UPDATE artno = VALUES(artno), created_by = VALUES(created_by), created_at = CURRENT_TIMESTAMP""",
        (normalized, artno, created_by)
    )
    logger.info("Alias saved: '%s' -> '%s'", normalized, artno)
    return True


async def delete_alias(pool, alias_id):
    """Delete an alias by ID."""
    return await execute_modify(pool, "DELETE FROM tokohub.stock_alias WHERE id = %s", (alias_id,))


async def list_aliases(pool, page=1, per_page=50):
    """Return paginated aliases with stock name."""
    offset = (page - 1) * per_page
    rows = await execute_query(
        pool,
        """SELECT a.id, a.alias_name, a.artno, a.created_at, a.created_by,
                  s.artname
           FROM tokohub.stock_alias a
           LEFT JOIN stock s ON s.artno = a.artno
           ORDER BY a.created_at DESC
           LIMIT %s OFFSET %s""",
        (per_page, offset)
    )
    count_row = await execute_single(pool, "SELECT COUNT(*) AS total FROM tokohub.stock_alias")
    return rows, count_row['total']
