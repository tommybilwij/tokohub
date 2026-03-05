"""Health check and LAN status routes."""

from fastapi import APIRouter, Request

from config import settings
from services.lan_auth import get_local_ip

router = APIRouter()


@router.get('/health')
async def health():
    return {'status': 'ok'}


@router.get('/api/lan/status')
async def api_lan_status(request: Request):
    https_port = request.app.state.https_port
    ip = get_local_ip()
    https_url = ''
    mdns_host = f'{settings.mdns_hostname}.local'
    if settings.lan_mode and https_port:
        if https_port == 443:
            https_url = f'https://{mdns_host}'
        else:
            https_url = f'https://{mdns_host}:{https_port}'
    return {
        'lan_mode': settings.lan_mode,
        'local_ip': ip,
        'port': settings.server_port,
        'https_port': https_port,
        'url': f'http://{ip}:{settings.server_port}' if settings.lan_mode else '',
        'https_url': https_url,
    }
