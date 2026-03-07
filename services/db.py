"""Async database pool for MariaDB/MySQL using aiomysql."""

import logging

import aiomysql

from config import settings

logger = logging.getLogger(__name__)

_pool: aiomysql.Pool | None = None


async def create_pool():
    """Create the global connection pool."""
    global _pool
    cfg = settings.db
    _pool = await aiomysql.create_pool(
        host=cfg.host,
        port=cfg.port,
        user=cfg.user,
        password=cfg.password,
        db=cfg.name,
        charset=cfg.charset,
        minsize=2,
        maxsize=cfg.pool_size,
        autocommit=True,
        pool_recycle=300,
        connect_timeout=10,
    )
    logger.info("Database connection pool created (%s connections)", cfg.pool_size)


async def close_pool():
    """Close the global connection pool."""
    global _pool
    if _pool:
        _pool.close()
        await _pool.wait_closed()
        _pool = None
        logger.info("Database connection pool closed")


def get_pool() -> aiomysql.Pool:
    """Return the singleton connection pool."""
    return _pool


async def execute_query(pool, sql, params=None):
    """Run a SELECT and return all rows as dicts."""
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(sql, params or ())
            return await cur.fetchall()


async def execute_single(pool, sql, params=None):
    """Run a SELECT and return the first row or None."""
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(sql, params or ())
            return await cur.fetchone()


async def execute_modify(pool, sql, params=None):
    """Run an INSERT/UPDATE/DELETE and return rows affected."""
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(sql, params or ())
            return cur.rowcount
