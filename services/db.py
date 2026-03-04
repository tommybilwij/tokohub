"""Database connection pool for MariaDB/MySQL."""

import logging
from contextlib import contextmanager

from mysql.connector import pooling

from config import settings

logger = logging.getLogger(__name__)

_pool = None


def get_pool():
    """Return the singleton connection pool, creating it on first call."""
    global _pool
    if _pool is None:
        db_config = settings.db.to_connector_kwargs()
        _pool = pooling.MySQLConnectionPool(**db_config)
        logger.info("Database connection pool created (%s connections)", settings.db.pool_size)
    return _pool


@contextmanager
def get_connection():
    """Yield a connection from the pool, returning it on exit.

    Autocommit is disabled so that callers can use proper transactions
    (commit/rollback).  The helper ``get_cursor`` already commits on
    success and rolls back on failure.
    """
    conn = get_pool().get_connection()
    conn.autocommit = False
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def get_cursor(dictionary=True):
    """Yield a cursor with auto-close. Results are dicts by default."""
    with get_connection() as conn:
        cursor = conn.cursor(dictionary=dictionary)
        try:
            yield cursor
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cursor.close()


def execute_query(sql, params=None, dictionary=True):
    """Run a SELECT and return all rows."""
    with get_cursor(dictionary=dictionary) as cur:
        cur.execute(sql, params or ())
        return cur.fetchall()


def execute_single(sql, params=None, dictionary=True):
    """Run a SELECT and return the first row or None."""
    with get_cursor(dictionary=dictionary) as cur:
        cur.execute(sql, params or ())
        return cur.fetchone()


def execute_modify(sql, params=None):
    """Run an INSERT/UPDATE/DELETE and return rows affected."""
    with get_cursor() as cur:
        cur.execute(sql, params or ())
        return cur.rowcount
