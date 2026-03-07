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
