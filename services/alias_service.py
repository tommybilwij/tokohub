"""CRUD operations for the stock_alias table."""

import logging

from services.db import execute_query, execute_single, execute_modify

logger = logging.getLogger(__name__)


def normalize_alias(name):
    """Normalize an alias name for consistent lookup."""
    import re
    name = name.upper().strip()
    name = re.sub(r'[^\w\s]', ' ', name)
    name = re.sub(r'\s+', ' ', name)
    # Normalize common unit abbreviations
    for long, short in [('GRAM', 'G'), ('GR', 'G'), ('LITER', 'L'), ('LTR', 'L'),
                        ('MILI', 'ML'), ('KILO', 'KG')]:
        name = re.sub(rf'\b{long}\b', short, name)
    return name.strip()


def find_by_alias(name):
    """Look up an artno by alias name. Returns artno or None."""
    normalized = normalize_alias(name)
    row = execute_single(
        "SELECT artno FROM stock_alias WHERE alias_name = %s",
        (normalized,)
    )
    return row['artno'] if row else None


def save_alias(alias_name, artno, created_by='RECEIPT_APP'):
    """Save or update an alias mapping. Overwrites artno if alias already exists."""
    normalized = normalize_alias(alias_name)
    execute_modify(
        """INSERT INTO stock_alias (alias_name, artno, created_by)
           VALUES (%s, %s, %s)
           ON DUPLICATE KEY UPDATE artno = VALUES(artno), created_by = VALUES(created_by), created_at = CURRENT_TIMESTAMP""",
        (normalized, artno, created_by)
    )
    logger.info("Alias saved: '%s' -> '%s'", normalized, artno)
    return True


def delete_alias(alias_id):
    """Delete an alias by ID."""
    return execute_modify("DELETE FROM stock_alias WHERE id = %s", (alias_id,))


def list_aliases(page=1, per_page=50):
    """Return paginated aliases with stock name."""
    offset = (page - 1) * per_page
    rows = execute_query(
        """SELECT a.id, a.alias_name, a.artno, a.created_at, a.created_by,
                  s.artname
           FROM stock_alias a
           LEFT JOIN stock s ON s.artno = a.artno
           ORDER BY a.created_at DESC
           LIMIT %s OFFSET %s""",
        (per_page, offset)
    )
    count_row = execute_single("SELECT COUNT(*) AS total FROM stock_alias")
    return rows, count_row['total']
