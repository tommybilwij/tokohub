"""FastAPI middleware for setup gating, auth, and LAN auth."""

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import RedirectResponse, JSONResponse

from config import _ENVRC_PATH
from services.lan_auth import is_private_ip
from services.auth import decode_session_token, get_auth_record, SESSION_COOKIE

_SETUP_PASSTHROUGH = ('/setup', '/api/setup', '/api/settings', '/api/restart', '/health', '/static')
_AUTH_PASSTHROUGH = ('/login', '/api/auth/login', '/api/auth/user-list', '/api/auth/register',
                     '/health', '/static', '/setup', '/api/setup', '/api/settings', '/api/restart')
_LOCALHOST = {'127.0.0.1', '::1'}


class SetupGateMiddleware(BaseHTTPMiddleware):
    """Redirect to /setup if .envrc doesn't exist or DB is not connected."""

    async def dispatch(self, request, call_next):
        needs_setup = not _ENVRC_PATH.exists() or getattr(request.app.state, 'db_pool', None) is None
        if needs_setup:
            path = request.url.path
            if not any(path.startswith(p) for p in _SETUP_PASSTHROUGH):
                return RedirectResponse('/setup')
        return await call_next(request)


class AuthMiddleware(BaseHTTPMiddleware):
    """Check session cookie and inject user into request.state."""

    async def dispatch(self, request, call_next):
        request.state.user = None
        path = request.url.path

        # Skip auth for passthrough paths
        if any(path.startswith(p) for p in _AUTH_PASSTHROUGH):
            # Still decode token if present (for register check)
            token = request.cookies.get(SESSION_COOKIE)
            if token:
                data = decode_session_token(token)
                if data:
                    request.state.user = {
                        'username': data['u'], 'role': data['r'],
                    }
            return await call_next(request)

        token = request.cookies.get(SESSION_COOKIE)
        if not token:
            if path.startswith('/api/'):
                return JSONResponse({'error': 'Not authenticated'}, status_code=401)
            return RedirectResponse('/login')

        data = decode_session_token(token)
        if not data:
            if path.startswith('/api/'):
                return JSONResponse({'error': 'Session expired'}, status_code=401)
            resp = RedirectResponse('/login')
            resp.delete_cookie(SESSION_COOKIE)
            return resp

        # Load full user record for permissions
        pool = request.app.state.db_pool
        record = await get_auth_record(pool, data['u'])
        if not record:
            resp = RedirectResponse('/login')
            resp.delete_cookie(SESSION_COOKIE)
            return resp

        request.state.user = {
            'username': data['u'],
            'role': record['role'],
        }
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
