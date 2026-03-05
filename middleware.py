"""FastAPI middleware for setup gating and LAN auth."""

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import RedirectResponse, JSONResponse

from config import _ENVRC_PATH
from services.lan_auth import is_private_ip

_SETUP_PASSTHROUGH = ('/setup', '/api/setup', '/api/settings', '/health', '/static')
_LOCALHOST = {'127.0.0.1', '::1'}


class SetupGateMiddleware(BaseHTTPMiddleware):
    """Redirect to /setup if .envrc doesn't exist yet."""

    async def dispatch(self, request, call_next):
        if not _ENVRC_PATH.exists():
            path = request.url.path
            if not any(path.startswith(p) for p in _SETUP_PASSTHROUGH):
                return RedirectResponse('/setup')
        return await call_next(request)


class LANAuthMiddleware(BaseHTTPMiddleware):
    """Block requests from non-private IPs."""

    async def dispatch(self, request, call_next):
        remote = request.client.host if request.client else ''

        # Localhost always allowed (Tauri WebView)
        if remote in _LOCALHOST:
            return await call_next(request)

        # Health endpoint always open (Tauri polling)
        if request.url.path == '/health':
            return await call_next(request)

        # Remote clients: must be on private network
        if not is_private_ip(remote):
            return JSONResponse({'error': 'Forbidden'}, status_code=403)

        return await call_next(request)
