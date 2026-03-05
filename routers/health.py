"""Health check and LAN status routes."""

import aiomysql
from fastapi import APIRouter, Depends

from config import settings
from dependencies import get_db
from services.lan_auth import get_local_ip

router = APIRouter()


@router.get('/health')
async def health():
    return {'status': 'ok'}


@router.get('/api/lan/status')
async def api_lan_status():
    from app import _lan_active, _https_port
    ip = get_local_ip()
    https_url = ''
    mdns_host = f'{settings.mdns_hostname}.local'
    if _lan_active and _https_port:
        if _https_port == 443:
            https_url = f'https://{mdns_host}'
        else:
            https_url = f'https://{mdns_host}:{_https_port}'
    return {
        'lan_mode': _lan_active,
        'local_ip': ip,
        'port': settings.server_port,
        'https_port': _https_port,
        'url': f'http://{ip}:{settings.server_port}' if _lan_active else '',
        'https_url': https_url,
    }
