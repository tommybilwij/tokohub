"""Authentication and session management."""

import hashlib
import logging
import secrets

from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

from services.db import execute_query, execute_single, execute_modify

logger = logging.getLogger(__name__)

# Session cookie config
_SECRET_KEY = None
_SERIALIZER = None
SESSION_COOKIE = 'tokohub_session'
SESSION_MAX_AGE = 86400 * 7  # 7 days

# All pages that can be permission-controlled
PAGES = {
    'scanner':      'Scanner',
    'entry':        'Input Faktur',
    'history':      'Daftar Faktur',
    'history:edit': 'Edit Faktur',
    'sales':        'Penjualan',
    'sales:harga':  'Harga Jual',
    'sales:total':  'Total',
    'foc':          'Barang Bonus',
    'aliases':      'Alias',
    'price_change': 'Perubahan Harga',
    'ph:update_purch_price': 'Update Harga Beli',
    'ph:lock_history': 'Kunci Riwayat',
    'price_report': 'Laporan Harga',
}

# Pages restricted to admin only (not configurable)
ADMIN_PAGES = {'settings', 'users'}


def _get_serializer() -> URLSafeTimedSerializer:
    global _SECRET_KEY, _SERIALIZER
    if _SERIALIZER is None:
        _SECRET_KEY = secrets.token_hex(32)
        _SERIALIZER = URLSafeTimedSerializer(_SECRET_KEY)
    return _SERIALIZER


def hash_password(password: str) -> str:
    """SHA-256 hash of password with app-level salt."""
    salted = f'tokohub:{password}'
    return hashlib.sha256(salted.encode()).hexdigest()


def verify_password(password: str, password_hash: str) -> bool:
    return hash_password(password) == password_hash


def create_session_token(username: str, role: str) -> str:
    return _get_serializer().dumps({'u': username, 'r': role})


def decode_session_token(token: str) -> dict | None:
    """Decode session token. Returns {'u': username, 'r': role} or None."""
    try:
        data = _get_serializer().loads(token, max_age=SESSION_MAX_AGE)
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
    """Check if a role can access a given page."""
    if role == 'admin':
        return True
    if page in ADMIN_PAGES:
        return False
    perms = await get_role_permissions(pool, role)
    return page in perms.split(',')
