"""Authentication API routes."""

import logging

import aiomysql
from fastapi import APIRouter, Request, Depends, Response
from fastapi.responses import JSONResponse

from dependencies import get_db
from services.db import execute_query
from services.auth import (
    get_user_list, get_auth_record, get_all_auth,
    verify_password, set_password, update_role, delete_auth,
    get_all_roles, get_role_permissions, set_role_permissions,
    delete_role, count_users_with_role,
    create_session_token, decode_session_token,
    SESSION_COOKIE, _get_session_max_age, PAGES,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix='/api/auth')


@router.get('/user-list')
async def api_user_list(db: aiomysql.Pool = Depends(get_db)):
    """List users from myposse_users (source of truth for usernames)."""
    rows = await get_user_list(db)
    return [{'nouser': r['nouser'], 'usrname': r['usrname']} for r in rows]


@router.post('/login')
async def api_login(request: Request, db: aiomysql.Pool = Depends(get_db)):
    body = await request.json()
    username = (body.get('username') or '').strip()
    password = body.get('password', '')

    if not username or not password:
        return JSONResponse({'error': 'Username dan password harus diisi'}, status_code=400)

    record = await get_auth_record(db, username)
    if not record:
        return JSONResponse({'error': 'User belum terdaftar. Hubungi admin.'}, status_code=401)

    if not verify_password(password, record['password_hash']):
        return JSONResponse({'error': 'Password salah'}, status_code=401)

    token = create_session_token(username, record['role'])
    resp = JSONResponse({'ok': True, 'role': record['role'], 'username': username})
    resp.set_cookie(
        SESSION_COOKIE, token,
        max_age=_get_session_max_age(), httponly=True, samesite='lax',
    )
    return resp


@router.post('/logout')
async def api_logout():
    resp = JSONResponse({'ok': True})
    resp.delete_cookie(SESSION_COOKIE)
    return resp


@router.get('/me')
async def api_me(request: Request):
    """Return current logged-in user info."""
    user = getattr(request.state, 'user', None)
    if not user:
        return JSONResponse({'error': 'Not authenticated'}, status_code=401)
    return {
        'username': user['username'],
        'role': user['role'],
    }


# --- Admin: user management ---

@router.get('/users')
async def api_users(request: Request, db: aiomysql.Pool = Depends(get_db)):
    """List all auth users with their kasir names."""
    user = getattr(request.state, 'user', None)
    if not user or user['role'] != 'admin':
        return JSONResponse({'error': 'Forbidden'}, status_code=403)

    auth_rows = await get_all_auth(db)
    user_rows = await get_user_list(db)
    user_map = {r['nouser']: r['usrname'] for r in user_rows}

    result = []
    for r in auth_rows:
        result.append({
            'username': r['username'],
            'usrname': user_map.get(r['username'], r['username']),
            'role': r['role'],
        })
    return result


@router.post('/register')
async def api_register(request: Request, db: aiomysql.Pool = Depends(get_db)):
    """Register a new user (admin only, or self-register if no users exist)."""
    body = await request.json()
    username = (body.get('username') or '').strip()
    password = body.get('password', '')
    role = body.get('role')

    if not username or not password:
        return JSONResponse({'error': 'Username dan password harus diisi'}, status_code=400)

    if len(password) < 4:
        return JSONResponse({'error': 'Password minimal 4 karakter'}, status_code=400)

    # Check if any users exist (first user can self-register)
    existing_users = await get_all_auth(db)
    user = getattr(request.state, 'user', None)

    if existing_users and (not user or user['role'] != 'admin'):
        return JSONResponse({'error': 'Hanya admin yang dapat mendaftarkan user'}, status_code=403)

    existing = await get_auth_record(db, username)
    if existing:
        return JSONResponse({'error': 'User sudah terdaftar'}, status_code=409)

    await set_password(db, username, password, role)
    return {'ok': True}


@router.post('/users/{username}/role')
async def api_update_role(username: str, request: Request, db: aiomysql.Pool = Depends(get_db)):
    user = getattr(request.state, 'user', None)
    if not user or user['role'] != 'admin':
        return JSONResponse({'error': 'Forbidden'}, status_code=403)

    body = await request.json()
    role = body.get('role', '').strip()
    if not role:
        return JSONResponse({'error': 'Role harus diisi'}, status_code=400)

    # Validate role exists (admin is always valid)
    if role != 'admin':
        roles = await get_all_roles(db)
        valid_roles = {r['role'] for r in roles}
        if role not in valid_roles:
            return JSONResponse({'error': 'Role tidak ditemukan'}, status_code=400)

    # Prevent removing the last admin
    if role != 'admin':
        all_users = await get_all_auth(db)
        admin_count = sum(1 for u in all_users if u['role'] == 'admin')
        target = await get_auth_record(db, username)
        if target and target['role'] == 'admin' and admin_count <= 1:
            return JSONResponse({'error': 'Harus ada minimal satu admin'}, status_code=400)

    await update_role(db, username, role)
    return {'ok': True}


@router.get('/roles')
async def api_roles(request: Request, db: aiomysql.Pool = Depends(get_db)):
    """List all custom roles."""
    user = getattr(request.state, 'user', None)
    if not user or user['role'] != 'admin':
        return JSONResponse({'error': 'Forbidden'}, status_code=403)
    roles = await get_all_roles(db)
    return [{'role': r['role'], 'permissions': r['permissions']} for r in roles]


@router.get('/role-permissions/{role}')
async def api_get_role_permissions(role: str, request: Request, db: aiomysql.Pool = Depends(get_db)):
    user = getattr(request.state, 'user', None)
    if not user or user['role'] != 'admin':
        return JSONResponse({'error': 'Forbidden'}, status_code=403)
    perms = await get_role_permissions(db, role)
    return {'role': role, 'permissions': perms}


@router.post('/role-permissions/{role}')
async def api_set_role_permissions(role: str, request: Request, db: aiomysql.Pool = Depends(get_db)):
    """Create or update a role's permissions."""
    user = getattr(request.state, 'user', None)
    if not user or user['role'] != 'admin':
        return JSONResponse({'error': 'Forbidden'}, status_code=403)
    if role == 'admin':
        return JSONResponse({'error': 'Admin selalu punya akses semua halaman'}, status_code=400)
    body = await request.json()
    permissions = body.get('permissions', [])
    await set_role_permissions(db, role, permissions)
    return {'ok': True}


@router.delete('/roles/{role}')
async def api_delete_role(role: str, request: Request, db: aiomysql.Pool = Depends(get_db)):
    user = getattr(request.state, 'user', None)
    if not user or user['role'] != 'admin':
        return JSONResponse({'error': 'Forbidden'}, status_code=403)
    if role == 'admin':
        return JSONResponse({'error': 'Role admin tidak bisa dihapus'}, status_code=400)
    count = await count_users_with_role(db, role)
    if count > 0:
        return JSONResponse(
            {'error': f'Role "{role}" masih digunakan oleh {count} user. Pindahkan user terlebih dahulu.'},
            status_code=400,
        )
    await delete_role(db, role)
    return {'ok': True}


@router.post('/users/{username}/password')
async def api_reset_password(username: str, request: Request, db: aiomysql.Pool = Depends(get_db)):
    user = getattr(request.state, 'user', None)
    if not user or user['role'] != 'admin':
        return JSONResponse({'error': 'Forbidden'}, status_code=403)

    body = await request.json()
    password = body.get('password', '')
    if len(password) < 4:
        return JSONResponse({'error': 'Password minimal 4 karakter'}, status_code=400)

    await set_password(db, username, password)
    return {'ok': True}


@router.delete('/users/{username}')
async def api_delete_user(username: str, request: Request, db: aiomysql.Pool = Depends(get_db)):
    user = getattr(request.state, 'user', None)
    if not user or user['role'] != 'admin':
        return JSONResponse({'error': 'Forbidden'}, status_code=403)

    if username == user['username']:
        return JSONResponse({'error': 'Tidak bisa menghapus akun sendiri'}, status_code=400)

    # Prevent deleting last user
    all_users = await execute_query(db, "SELECT username, role FROM tokohub.auth")
    if len(all_users) <= 1:
        return JSONResponse({'error': 'Tidak bisa menghapus user terakhir'}, status_code=400)

    # Prevent deleting last admin
    target = next((u for u in all_users if u['username'] == username), None)
    if target and target['role'] == 'admin':
        admin_count = sum(1 for u in all_users if u['role'] == 'admin')
        if admin_count <= 1:
            return JSONResponse({'error': 'Tidak bisa menghapus admin terakhir'}, status_code=400)

    await delete_auth(db, username)
    return {'ok': True}
