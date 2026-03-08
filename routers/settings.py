"""Settings API routes."""

import os
import sys
import logging
import threading

from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse

import aiomysql

from dependencies import get_db

import config
from config import save_to_envrc, _ENVRC_PATH
from models.settings import SettingsUpdate
from services.llm import get_openai_config, save_openai_config
from services import app_settings

logger = logging.getLogger(__name__)

_DB_KEYS = ('fuzzy_cache_ttl', 'fuzzy_top_n', 'fuzzy_min_score',
            'pc_top_n', 'pc_min_score', 'po_top_n', 'po_min_score',
            'session_max_age')


async def _get_db_settings(pool) -> dict:
    """Read fuzzy settings from DB, return as int dict."""
    all_s = await app_settings.get_all(pool)
    return {k: int(all_s.get(k, 0)) for k in _DB_KEYS}

router = APIRouter()


def _mask(value: str, visible: int = 4) -> str:
    """Mask a secret, showing only the last `visible` chars."""
    if not value or len(value) <= visible:
        return value
    return '*' * (len(value) - visible) + value[-visible:]


@router.get('/api/settings')
async def api_settings_get(db: aiomysql.Pool = Depends(get_db)):
    openai_cfg = await get_openai_config(db)
    return {
        'db': {
            'host': config.settings.db.host,
            'port': config.settings.db.port,
            'user': config.settings.db.user,
            'password': _mask(config.settings.db.password),
            'name': config.settings.db.name,
            'pool_size': config.settings.db.pool_size,
        },
        'openai': {
            'api_base': openai_cfg['api_base'],
            'api_key': _mask(openai_cfg['api_key']),
            'deployment_id': openai_cfg['deployment_id'],
            'api_version': openai_cfg['api_version'],
        },
        **(await _get_db_settings(db)),
        'server_port': config.settings.server_port,
        'server_host': config.settings.server_host,
        'lan_mode': config.settings.lan_mode,
        'mdns_hostname': config.settings.mdns_hostname,
        'store_name': config.settings.store_name,
        'store_location': config.settings.store_location,
    }


def _strip_masked(data: dict) -> dict:
    """Strip masked password fields (user didn't change them)."""
    if 'db' in data and 'password' in data['db']:
        if data['db']['password'] == '' or '*' in data['db']['password']:
            del data['db']['password']
    if 'openai' in data and 'api_key' in data['openai']:
        if data['openai']['api_key'] == '' or '*' in data['openai']['api_key']:
            del data['openai']['api_key']
    return data


@router.post('/api/settings')
async def api_settings_post(data: SettingsUpdate, db: aiomysql.Pool = Depends(get_db)):
    raw = _strip_masked(data.model_dump(exclude_none=True))
    try:
        # Save OpenAI config to DB
        if 'openai' in raw:
            openai_data = raw.pop('openai')
            existing = await get_openai_config(db)
            existing.update(openai_data)
            await save_openai_config(db, existing)

        # Save fuzzy matching settings to DB (no restart needed)
        fuzzy_data = {}
        for k in _DB_KEYS:
            if k in raw:
                fuzzy_data[k] = raw.pop(k)
        if fuzzy_data:
            await app_settings.save_many(db, fuzzy_data)

        # Save everything else to envrc
        if raw:
            save_to_envrc(raw)
        return {'ok': True}
    except Exception as e:
        logger.exception("Failed to save settings")
        return JSONResponse({'error': str(e)}, status_code=500)


@router.post('/api/setup')
async def api_setup(data: SettingsUpdate, db: aiomysql.Pool = Depends(get_db)):
    raw = _strip_masked(data.model_dump(exclude_none=True))
    try:
        if 'openai' in raw:
            openai_data = raw.pop('openai')
            existing = await get_openai_config(db)
            existing.update(openai_data)
            await save_openai_config(db, existing)

        # Save DB-stored settings (fuzzy matching, session)
        fuzzy_data = {}
        for k in _DB_KEYS:
            if k in raw:
                fuzzy_data[k] = raw.pop(k)
        if fuzzy_data and db:
            await app_settings.save_many(db, fuzzy_data)

        if raw:
            save_to_envrc(raw)
        return {'ok': True}
    except Exception as e:
        logger.exception("Failed to save setup")
        return JSONResponse({'error': str(e)}, status_code=500)


@router.post('/api/restart')
async def api_restart():
    """Restart the server process. Works on macOS, Linux, and Windows."""

    def _restart():
        import time, subprocess
        time.sleep(0.5)  # let the response flush
        is_frozen = getattr(sys, 'frozen', False)

        if sys.platform == 'win32':
            # Windows: spawn a new process then exit the current one
            if is_frozen:
                subprocess.Popen([sys.executable] + sys.argv[1:])
            else:
                subprocess.Popen([sys.executable] + sys.argv)
            os._exit(0)
        else:
            # Unix: close inherited file descriptors, then exec
            try:
                import resource
                soft, _ = resource.getrlimit(resource.RLIMIT_NOFILE)
            except ImportError:
                soft = 1024
            os.closerange(3, soft)
            if is_frozen:
                os.execv(sys.executable, sys.argv)
            else:
                os.execv(sys.executable, [sys.executable] + sys.argv)

    threading.Thread(target=_restart, daemon=True).start()
    return {'ok': True}


