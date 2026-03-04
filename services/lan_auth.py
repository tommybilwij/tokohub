"""LAN mode — restrict access to private network IPs only."""

import ipaddress
import logging
import socket

from flask import Flask, request, abort

logger = logging.getLogger(__name__)

_PRIVATE_NETWORKS = [
    ipaddress.ip_network('192.168.0.0/16'),
    ipaddress.ip_network('10.0.0.0/8'),
    ipaddress.ip_network('172.16.0.0/12'),
]

_LOCALHOST = {'127.0.0.1', '::1'}


def get_local_ip() -> str:
    """Get the machine's local network IP address."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'


def _is_private_ip(ip_str: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip_str)
        return any(addr in net for net in _PRIVATE_NETWORKS)
    except ValueError:
        return False


def setup_lan_auth(app: Flask):
    """Register before_request hook that only allows private network IPs."""

    @app.before_request
    def _lan_auth_check():
        remote = request.remote_addr or ''

        # Localhost always allowed (Tauri WebView)
        if remote in _LOCALHOST:
            return None

        # Health endpoint always open (Tauri polling)
        if request.path == '/health':
            return None

        # Remote clients: must be on private network
        if not _is_private_ip(remote):
            abort(403)

        return None
