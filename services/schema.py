"""Database schema initialization for the tokohub database.

Ensures the `tokohub` database and its tables exist on startup.
SQL definitions live in schema/tokohub/*.sql.
"""

import logging
from pathlib import Path

import aiomysql

logger = logging.getLogger(__name__)

_SCHEMA_DIR = Path(__file__).resolve().parent.parent / 'schema' / 'tokohub'


async def ensure_tokohub_schema(pool: aiomysql.Pool) -> None:
    """Create the tokohub database and run all schema SQL files."""
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("CREATE DATABASE IF NOT EXISTS tokohub")

    if not _SCHEMA_DIR.is_dir():
        return

    for sql_file in sorted(_SCHEMA_DIR.iterdir()):
        if sql_file.suffix != '.sql':
            continue
        sql = sql_file.read_text(encoding='utf-8').strip()
        if not sql:
            continue
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                for statement in (s.strip() for s in sql.split(';') if s.strip()):
                    await cur.execute(statement)
        logger.info("Schema ensured: %s", sql_file.name)

    # Column migrations — safely add columns that may not exist yet
    await _ensure_columns(pool)


async def _ensure_columns(pool: aiomysql.Pool) -> None:
    """Add columns to existing tables if they don't exist yet."""
    migrations = [
        ("tokohub.pesanan_pembelian", "keterangan",
         "ADD COLUMN keterangan VARCHAR(200) NOT NULL DEFAULT '' AFTER total_items"),
    ]
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            for table, column, alter_sql in migrations:
                try:
                    await cur.execute(
                        "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS "
                        "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s AND COLUMN_NAME=%s",
                        (table.split('.')[0], table.split('.')[1], column),
                    )
                    if not await cur.fetchone():
                        await cur.execute(f"ALTER TABLE {table} {alter_sql}")
                        logger.info("Migration: added %s.%s", table, column)
                except Exception as e:
                    logger.warning("Migration %s.%s skipped: %s", table, column, e)
