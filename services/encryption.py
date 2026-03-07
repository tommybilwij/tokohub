"""Persistent encryption keys for password hashing and session signing.

On first startup, generates a `.enc` file with:
  - SECRET_KEY: used for session cookie signing (survives restarts)
  - PEPPER: mixed into password hashes for an extra layer beyond per-user salt

The `.enc` file lives alongside `.envrc` (project root in dev, ~/.tokohub in frozen/Tauri builds).
"""

import logging
import secrets
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

if getattr(sys, 'frozen', False):
    _ENC_PATH = Path.home() / '.tokohub' / '.enc'
else:
    _ENC_PATH = Path(__file__).resolve().parent.parent / '.enc'

_cache: dict[str, str] = {}


def _load() -> dict[str, str]:
    """Load key=value pairs from the .enc file."""
    if _cache:
        return _cache
    if _ENC_PATH.exists():
        for line in _ENC_PATH.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                k, v = line.split('=', 1)
                _cache[k.strip()] = v.strip()
    return _cache


def ensure_enc_file() -> None:
    """Create the .enc file with random keys if it doesn't exist."""
    if _ENC_PATH.exists():
        logger.info("Encryption keys loaded from %s", _ENC_PATH)
        return
    _ENC_PATH.parent.mkdir(parents=True, exist_ok=True)
    secret_key = secrets.token_hex(32)
    pepper = secrets.token_hex(32)
    _ENC_PATH.write_text(
        f"SECRET_KEY={secret_key}\nPEPPER={pepper}\n",
        encoding='utf-8',
    )
    _cache.clear()
    logger.info("Generated new encryption keys at %s", _ENC_PATH)


def get_secret_key() -> str:
    """Return the persistent secret key for session signing."""
    data = _load()
    key = data.get('SECRET_KEY')
    if not key:
        ensure_enc_file()
        _cache.clear()
        data = _load()
        key = data['SECRET_KEY']
    return key


def get_pepper() -> str:
    """Return the pepper for password hashing."""
    data = _load()
    pepper = data.get('PEPPER')
    if not pepper:
        ensure_enc_file()
        _cache.clear()
        data = _load()
        pepper = data['PEPPER']
    return pepper
