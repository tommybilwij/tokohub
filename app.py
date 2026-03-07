"""FastAPI application for TokoHub."""

import asyncio
import os
import sys
import argparse
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from config import settings, _ENVRC_PATH

# Resolve base directory (supports PyInstaller frozen builds)
if getattr(sys, 'frozen', False):
    _BASE_DIR = Path(sys._MEIPASS)
else:
    _BASE_DIR = Path(__file__).parent

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s'
)
logger = logging.getLogger(__name__)
logging.getLogger('zeroconf').setLevel(logging.ERROR)

os.makedirs(settings.upload_folder, exist_ok=True)

_lifespan_lock = asyncio.Lock()
_lifespan_count = 0


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown: create and close DB pool (safe for dual servers)."""
    global _lifespan_count
    from services.db import create_pool, close_pool, get_pool
    async with _lifespan_lock:
        _lifespan_count += 1
        if get_pool() is None:
            await create_pool()
    app.state.db_pool = get_pool()
    from services.schema import ensure_tokohub_schema
    await ensure_tokohub_schema(app.state.db_pool)
    yield
    async with _lifespan_lock:
        _lifespan_count -= 1
        if _lifespan_count == 0:
            await close_pool()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)

# Static files
app.mount('/static', StaticFiles(directory=str(_BASE_DIR / 'static')), name='static')

# Templates
templates = Jinja2Templates(directory=str(_BASE_DIR / 'templates'))
templates.env.globals['url_for'] = lambda name, filename='': f'/static/{filename}'
templates.env.globals['store_name'] = settings.store_name
app.state.templates = templates
app.state.lan_active = settings.lan_mode
app.state.https_port = None

# Middleware (order matters: last added = outermost)
from middleware import SetupGateMiddleware
app.add_middleware(SetupGateMiddleware)

if settings.lan_mode:
    from middleware import LANAuthMiddleware
    app.add_middleware(LANAuthMiddleware)

# Routers
from routers import pages, settings as settings_router, stock, receipt, sales, foc, health
for r in [pages, settings_router, stock, receipt, sales, foc, health]:
    app.include_router(r.router)


# Context processor equivalent: inject store_name into all template renders
@app.middleware('http')
async def inject_branding(request, call_next):
    templates.env.globals['store_name'] = settings.store_name
    return await call_next(request)


def _parse_args():
    parser = argparse.ArgumentParser(description='TokoHub Server')
    parser.add_argument('--port', type=int, default=settings.server_port)
    parser.add_argument('--host', type=str, default=settings.server_host)
    parser.add_argument('--lan', action='store_true', default=settings.lan_mode)
    parser.add_argument('--_worker', action='store_true', help=argparse.SUPPRESS)
    return parser.parse_args()


def _run_with_reloader(target_fn):
    """Watch .py files and restart the process on changes (dev mode)."""
    import subprocess
    from watchfiles import watch

    process = None
    try:
        while True:
            logger.info("Starting server (dev mode with auto-reload)...")
            process = subprocess.Popen([sys.executable] + sys.argv + ['--_worker'])
            # Block until a .py file changes
            for _changes in watch('.', watch_filter=lambda _, path: path.endswith('.py')):
                logger.info("File change detected, restarting...")
                break
            process.terminate()
            process.wait()
    except KeyboardInterrupt:
        if process:
            process.terminate()
            process.wait()


def main():
    import uvicorn

    args = _parse_args()
    is_frozen = getattr(sys, 'frozen', False)

    # Dev auto-reload: parent process watches files, restarts child
    if not is_frozen and '--_worker' not in sys.argv:
        _run_with_reloader(main)
        return

    host = args.host
    port = args.port

    if args.lan:
        host = '0.0.0.0'
        from services.lan_auth import get_local_ip
        local_ip = get_local_ip()
        logger.info("LAN mode enabled — access from: http://%s:%d", local_ip, port)

    # LAN: start HTTP + HTTPS via asyncio.gather
    if settings.lan_mode:
        try:
            from services.ssl import ensure_ssl_cert
            cert_file, key_file = ensure_ssl_cert(mdns_hostname=settings.mdns_hostname)

            https_port = None
            for try_port in (443, port + 1):
                try:
                    import socket
                    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    s.bind(('0.0.0.0', try_port))
                    s.close()
                    https_port = try_port
                    break
                except (PermissionError, OSError) as e:
                    logger.info("Cannot bind port %d (%s), trying next", try_port, e)

            if https_port:
                app.state.https_port = https_port

                # Register mDNS
                try:
                    import socket as _socket
                    from zeroconf import ServiceInfo, Zeroconf
                    mdns_host = f'{settings.mdns_hostname}.local'
                    svc = ServiceInfo(
                        "_https._tcp.local.",
                        "TokoHub._https._tcp.local.",
                        addresses=[_socket.inet_aton(local_ip)],
                        port=https_port,
                        server=f"{mdns_host}.",
                    )
                    zc = Zeroconf()
                    zc.register_service(svc)
                    url_display = f"https://{mdns_host}" if https_port == 443 else f"https://{mdns_host}:{https_port}"
                    logger.info("mDNS registered: %s", url_display)
                except Exception:
                    logger.warning("Could not register mDNS service", exc_info=True)

                # Run both HTTP and HTTPS servers
                async def _serve_dual():
                    http_config = uvicorn.Config(app, host=host, port=port, log_level='info')
                    https_config = uvicorn.Config(
                        app, host='0.0.0.0', port=https_port,
                        ssl_certfile=cert_file, ssl_keyfile=key_file, log_level='info',
                    )
                    http_server = uvicorn.Server(http_config)
                    https_server = uvicorn.Server(https_config)
                    logger.info("Serving HTTP on %s:%d, HTTPS on port %d", host, port, https_port)
                    await asyncio.gather(http_server.serve(), https_server.serve())

                asyncio.run(_serve_dual())
                return
        except Exception:
            logger.warning("Could not start HTTPS LAN server", exc_info=True)

    # Single server (no HTTPS port available, or LAN mode off)
    uvicorn.run(app, host=host, port=port, log_level='info')


if __name__ == '__main__':
    main()
