"""Settings API routes."""

import os
import sys
import signal
import logging
import threading

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from config import settings as _s, save_to_envrc, _ENVRC_PATH
from models.settings import SettingsUpdate

logger = logging.getLogger(__name__)

router = APIRouter()


def _mask(value: str, visible: int = 4) -> str:
    """Mask a secret, showing only the last `visible` chars."""
    if not value or len(value) <= visible:
        return value
    return '*' * (len(value) - visible) + value[-visible:]


@router.get('/api/settings')
async def api_settings_get():
    return {
        'db': {
            'host': _s.db.host,
            'port': _s.db.port,
            'user': _s.db.user,
            'password': _mask(_s.db.password),
            'name': _s.db.name,
            'pool_size': _s.db.pool_size,
        },
        'openai': {
            'api_base': _s.openai.api_base,
            'api_key': _mask(_s.openai.api_key),
            'deployment_id': _s.openai.deployment_id,
            'api_version': _s.openai.api_version,
        },
        'fuzzy_cache_ttl': _s.fuzzy_cache_ttl,
        'fuzzy_top_n': _s.fuzzy_top_n,
        'fuzzy_min_score': _s.fuzzy_min_score,
        'server_port': _s.server_port,
        'server_host': _s.server_host,
        'lan_mode': _s.lan_mode,
        'mdns_hostname': _s.mdns_hostname,
        'store_name': _s.store_name,
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
async def api_settings_post(data: SettingsUpdate):
    raw = _strip_masked(data.model_dump(exclude_none=True))
    try:
        save_to_envrc(raw)
        return {'ok': True}
    except Exception as e:
        logger.exception("Failed to save settings")
        return JSONResponse({'error': str(e)}, status_code=500)


@router.post('/api/setup')
async def api_setup(data: SettingsUpdate):
    raw = _strip_masked(data.model_dump(exclude_none=True))
    try:
        save_to_envrc(raw)
        return {'ok': True}
    except Exception as e:
        logger.exception("Failed to save setup")
        return JSONResponse({'error': str(e)}, status_code=500)


@router.post('/api/restart')
async def api_restart():
    """Restart the server process. Works in both dev and Tauri sidecar mode."""
    import resource

    def _restart():
        import time
        time.sleep(0.5)  # let the response flush
        soft, _ = resource.getrlimit(resource.RLIMIT_NOFILE)
        os.closerange(3, soft)
        is_frozen = getattr(sys, 'frozen', False)
        if is_frozen:
            os.execv(sys.executable, sys.argv)
        else:
            os.execv(sys.executable, [sys.executable] + sys.argv)

    threading.Thread(target=_restart, daemon=True).start()
    return {'ok': True}
