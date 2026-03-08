"""Authentication and session management."""

import hashlib
import logging
import os

from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

from services.db import execute_query, execute_single, execute_modify
from services.encryption import get_secret_key, get_pepper

logger = logging.getLogger(__name__)

# Session cookie config
_SERIALIZER = None
SESSION_COOKIE = 'tokohub_session'


def _get_session_max_age() -> int:
    """Get session max age from config."""
    from config import settings
    return settings.session_max_age

# All pages that can be permission-controlled
# Keys with ':' are rendered as indented sub-items in the permissions UI.
PAGES = {
    'scanner':                  'Scanner',
    'scanner:harga_beli':       'Harga Beli',
    'scanner:harga_jual':       'Harga Jual',
    'scanner:harga_jual:margin':'Margin Harga Jual',
    'faktur':                   'Faktur Pembelian',
    'faktur:input':             'Input Faktur Pembelian',
    'faktur:input:aliases':     'Alias',
    'faktur:daftar':            'Daftar Faktur Pembelian',
    'faktur:daftar:delete':     'Hapus Faktur',
    'faktur:daftar:edit':       'Edit Faktur',
    'faktur:daftar:lock':       'Kunci Faktur',
    'price_change':                     'Perubahan Harga',
    'price_change:daftar':              'Daftar Perubahan Harga',
    'price_change:daftar:edit':         'Edit Perubahan Harga',
    'price_change:daftar:delete':       'Hapus Perubahan Harga',
    'price_change:daftar:lock':         'Kunci Riwayat',
    'price_change:input':               'Input Perubahan Harga',
    'price_change:input:update_beli':   'Update Harga Beli',
    'pesanan':                  'Pesanan Pembelian',
    'pesanan:input':            'Buat Pesanan Pembelian',
    'pesanan:daftar':           'Daftar Pesanan Pembelian',
    'pesanan:daftar:edit':      'Edit Pesanan',
    'pesanan:daftar:delete':    'Hapus Pesanan',
    'laporan':                  'Laporan',
    'laporan:penjualan':        'Laporan Penjualan',
    'laporan:penjualan:total':  'Total Harga Jual',
    'laporan:perubahan_harga':  'Laporan Perubahan Harga',
    'laporan:barang_bonus':     'Laporan Barang Bonus',
}
# Pages restricted to admin only (not configurable)
ADMIN_PAGES = {'settings', 'users'}


def _get_serializer() -> URLSafeTimedSerializer:
    global _SERIALIZER
    if _SERIALIZER is None:
        _SERIALIZER = URLSafeTimedSerializer(get_secret_key())
    return _SERIALIZER


# --- Password hashing: PBKDF2-HMAC-SHA256 with pepper + per-user salt ---

_PBKDF2_ITERATIONS = 600_000
_PBKDF2_PREFIX = 'pbkdf2$'


def hash_password(password: str) -> str:
    """PBKDF2-HMAC-SHA256 with pepper and random salt.

    Returns: 'pbkdf2$iterations$salt_hex$hash_hex'
    """
    pepper = get_pepper()
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac(
        'sha256',
        (pepper + password).encode(),
        salt,
        _PBKDF2_ITERATIONS,
    )
    return f'{_PBKDF2_PREFIX}{_PBKDF2_ITERATIONS}${salt.hex()}${dk.hex()}'


def verify_password(password: str, password_hash: str) -> bool:
    """Verify password against stored PBKDF2 hash."""
    if not password_hash.startswith(_PBKDF2_PREFIX):
        return False
    _, iterations, salt_hex, hash_hex = password_hash.split('$')
    pepper = get_pepper()
    dk = hashlib.pbkdf2_hmac(
        'sha256',
        (pepper + password).encode(),
        bytes.fromhex(salt_hex),
        int(iterations),
    )
    return dk.hex() == hash_hex


def create_session_token(username: str, role: str) -> str:
    return _get_serializer().dumps({'u': username, 'r': role})


def decode_session_token(token: str) -> dict | None:
    """Decode session token. Returns {'u': username, 'r': role} or None."""
    try:
        data = _get_serializer().loads(token, max_age=_get_session_max_age())
        return data
    except (BadSignature, SignatureExpired):
        return None


async def get_user_list(pool) -> list[dict]:
    """Get all users from myposse_users (the user source of truth)."""
    return await execute_query(
        pool,
        "SELECT nouser, usrname FROM myposse_users.users ORDER BY nouser"
    )


async def get_auth_record(pool, username: str) -> dict | None:
    return await execute_single(
        pool,
        "SELECT username, password_hash, role, permissions "
        "FROM tokohub.auth WHERE username = %s",
        (username,),
    )


async def get_all_auth(pool) -> list[dict]:
    return await execute_query(
        pool,
        "SELECT username, role, permissions, created_at, updated_at "
        "FROM tokohub.auth ORDER BY username"
    )


async def set_password(pool, username: str, password: str, role: str = None) -> None:
    """Create or update auth record. If first user, auto-assign admin."""
    ph = hash_password(password)

    existing = await get_auth_record(pool, username)
    if existing:
        if role:
            await execute_modify(
                pool,
                "UPDATE tokohub.auth SET password_hash = %s, role = %s WHERE username = %s",
                (ph, role, username),
            )
        else:
            await execute_modify(
                pool,
                "UPDATE tokohub.auth SET password_hash = %s WHERE username = %s",
                (ph, username),
            )
    else:
        # First registered user becomes admin
        if role is None:
            count = await execute_single(pool, "SELECT COUNT(*) as cnt FROM tokohub.auth")
            role = 'admin' if count['cnt'] == 0 else 'karyawan'

        await execute_modify(
            pool,
            "INSERT INTO tokohub.auth (username, password_hash, role) "
            "VALUES (%s, %s, %s)",
            (username, ph, role),
        )
    logger.info("Password set for %s (role=%s)", username, role)


async def update_role(pool, username: str, role: str) -> None:
    await execute_modify(
        pool,
        "UPDATE tokohub.auth SET role = %s WHERE username = %s",
        (role, username),
    )


async def get_all_roles(pool) -> list[dict]:
    """Get all roles from role_permissions table."""
    return await execute_query(
        pool,
        "SELECT role, permissions FROM tokohub.role_permissions ORDER BY role"
    )


async def get_role_permissions(pool, role: str) -> str:
    """Get permissions string for a role."""
    row = await execute_single(
        pool,
        "SELECT permissions FROM tokohub.role_permissions WHERE role = %s",
        (role,),
    )
    return row['permissions'] if row else ''


async def set_role_permissions(pool, role: str, permissions: list[str]) -> None:
    """Create or update a role with permissions."""
    valid = [p for p in permissions if p in PAGES]
    await execute_modify(
        pool,
        "INSERT INTO tokohub.role_permissions (role, permissions) VALUES (%s, %s) "
        "ON DUPLICATE KEY UPDATE permissions = VALUES(permissions)",
        (role, ','.join(valid)),
    )


async def count_users_with_role(pool, role: str) -> int:
    """Count how many users have a given role."""
    row = await execute_single(
        pool,
        "SELECT COUNT(*) as cnt FROM tokohub.auth WHERE role = %s",
        (role,),
    )
    return row['cnt'] if row else 0


async def delete_role(pool, role: str) -> None:
    """Delete a role from role_permissions."""
    await execute_modify(
        pool,
        "DELETE FROM tokohub.role_permissions WHERE role = %s",
        (role,),
    )


async def delete_auth(pool, username: str) -> None:
    await execute_modify(pool, "DELETE FROM tokohub.auth WHERE username = %s", (username,))


async def has_page_access(pool, role: str, page: str) -> bool:
    """Check if a role can access a given page.

    Ancestor matching only applies to permissions NOT explicitly listed
    in PAGES (i.e. unlisted sub-paths).  If a permission is listed in
    PAGES it must be granted directly — a parent does not auto-grant
    its explicitly-defined children.
    """
    if role == 'admin':
        return True
    if page in ADMIN_PAGES:
        return False
    perms = await get_role_permissions(pool, role)
    perm_list = perms.split(',')
    if page in perm_list:
        return True
    # Only fall back to ancestor matching for permissions that are NOT
    # explicitly defined in PAGES (e.g. an ad-hoc sub-path).
    if page not in PAGES:
        parts = page.split(':')
        for i in range(1, len(parts)):
            ancestor = ':'.join(parts[:i])
            if ancestor in perm_list:
                return True
    return False
