"""HTML page routes."""

import aiomysql
from fastapi import APIRouter, Request, Depends
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from starlette.responses import JSONResponse

from dependencies import get_db, get_templates, get_current_user
from services.alias_service import list_aliases

from services.lan_auth import get_local_ip
from services.auth import PAGES, has_page_access, get_role_permissions
from config import settings

router = APIRouter()


async def _user_ctx(request: Request, user: dict | None) -> dict:
    """Build template context dict for user info + nav permissions."""
    if not user:
        return {'user': None, 'nav_pages': []}
    if user['role'] == 'admin':
        nav = list(PAGES.keys())
    else:
        pool = request.app.state.db_pool
        perms = await get_role_permissions(pool, user['role'])
        nav = [p for p in perms.split(',') if p in PAGES]
    return {'user': user, 'nav_pages': nav}


async def _check_page(request: Request, user: dict | None, page: str):
    """Return RedirectResponse if user cannot access page, else None."""
    if not user:
        return RedirectResponse('/login')
    pool = request.app.state.db_pool
    if not await has_page_access(pool, user['role'], page):
        return RedirectResponse('/')
    return None


@router.get('/')
async def index(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    if not user:
        return RedirectResponse('/login')
    return templates.TemplateResponse(request, 'home.html', await _user_ctx(request, user))


@router.get('/login')
async def login_page(request: Request, templates: Jinja2Templates = Depends(get_templates)):
    # If already logged in, redirect to home
    user = getattr(request.state, 'user', None)
    if user:
        return RedirectResponse('/')
    return templates.TemplateResponse(request, 'login.html')


@router.get('/setup')
async def setup_page(request: Request, templates: Jinja2Templates = Depends(get_templates)):
    return templates.TemplateResponse(request, 'setup.html')


@router.get('/faktur-pembelian/input')
async def entry_page(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'faktur:input')
    if denied: return denied
    return templates.TemplateResponse(request, 'receipt_form.html', await _user_ctx(request, user))


@router.get('/faktur-pembelian/aliases')
async def aliases_page(
    request: Request,
    page: int = 1,
    db: aiomysql.Pool = Depends(get_db),
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'faktur:input:aliases')
    if denied: return denied
    rows, total = await list_aliases(db, page=page)
    return templates.TemplateResponse(request, 'aliases.html', {
        'aliases': rows, 'total': total, 'page': page, **await _user_ctx(request, user),
    })


@router.get('/faktur-pembelian')
async def history_page(
    request: Request,
    db: aiomysql.Pool = Depends(get_db),
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    # Allow access if user has either entry or history permission
    pool = request.app.state.db_pool
    has_entry = await has_page_access(pool, user['role'], 'faktur:input')
    has_history = await has_page_access(pool, user['role'], 'faktur:daftar')
    if not has_entry and not has_history:
        denied = await _check_page(request, user, 'faktur')
        if denied: return denied
    can_edit = await has_page_access(pool, user['role'], 'faktur:daftar:edit')
    can_delete = await has_page_access(pool, user['role'], 'faktur:daftar:delete')
    can_lock = await has_page_access(pool, user['role'], 'faktur:daftar:lock')
    return templates.TemplateResponse(request, 'history.html', {
        'can_entry': has_entry, 'can_edit': can_edit, 'can_delete': can_delete, 'can_lock': can_lock,
        **await _user_ctx(request, user),
    })


@router.get('/scanner')
async def scanner_page(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'scanner')
    if denied: return denied
    pool = request.app.state.db_pool
    ctx = await _user_ctx(request, user)
    ctx['show_harga_beli'] = await has_page_access(pool, user['role'], 'scanner:harga_beli')
    ctx['show_harga_jual'] = await has_page_access(pool, user['role'], 'scanner:harga_jual')
    ctx['show_margin'] = await has_page_access(pool, user['role'], 'scanner:harga_jual:margin')
    return templates.TemplateResponse(request, 'scanner.html', ctx)


@router.get('/laporan')
async def laporan_page(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    # Allow if user has any report permission
    pool = request.app.state.db_pool
    has_sales = await has_page_access(pool, user['role'], 'laporan:penjualan')
    has_price_report = await has_page_access(pool, user['role'], 'laporan:perubahan_harga')
    has_foc = await has_page_access(pool, user['role'], 'laporan:barang_bonus')
    if not has_sales and not has_price_report and not has_foc:
        denied = await _check_page(request, user, 'laporan')
        if denied: return denied
    return templates.TemplateResponse(request, 'laporan.html', {
        'has_sales': has_sales,
        'has_price_report': has_price_report,
        'has_foc': has_foc,
        **await _user_ctx(request, user),
    })


@router.get('/laporan/penjualan')
async def sales_history_page(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'laporan:penjualan')
    if denied: return denied
    ctx = await _user_ctx(request, user)
    pool = request.app.state.db_pool
    ctx['show_total'] = await has_page_access(pool, user['role'], 'laporan:penjualan:total')
    return templates.TemplateResponse(request, 'sales_history.html', ctx)


@router.get('/laporan/barang-bonus')
async def foc_history_page(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'laporan:barang_bonus')
    if denied: return denied
    return templates.TemplateResponse(request, 'foc_history.html', await _user_ctx(request, user))


@router.get('/perubahan-harga')
async def price_change_page(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'price_change')
    if denied: return denied
    pool = request.app.state.db_pool
    ctx = await _user_ctx(request, user)
    ctx['can_entry'] = await has_page_access(pool, user['role'], 'price_change:input')
    ctx['can_delete'] = await has_page_access(pool, user['role'], 'price_change:daftar:delete')
    ctx['can_lock'] = await has_page_access(pool, user['role'], 'price_change:daftar:lock')
    return templates.TemplateResponse(request, 'price_change_history.html', ctx)


@router.get('/perubahan-harga/input')
async def price_change_entry_page(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'price_change:input')
    if denied: return denied
    pool = request.app.state.db_pool
    ctx = await _user_ctx(request, user)
    ctx['can_update_purch_price'] = await has_page_access(pool, user['role'], 'price_change:input:update_beli')
    ctx['can_lock_history'] = await has_page_access(pool, user['role'], 'price_change:daftar:lock')
    return templates.TemplateResponse(request, 'price_change.html', ctx)


@router.get('/laporan/perubahan-harga')
async def price_change_report_page(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'laporan:perubahan_harga')
    if denied: return denied
    return templates.TemplateResponse(request, 'price_change_report.html', await _user_ctx(request, user))


@router.get('/settings')
async def settings_page(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'settings')
    if denied: return denied
    return templates.TemplateResponse(request, 'settings.html', {
        'lan_mode': settings.lan_mode,
        'local_ip': get_local_ip(),
        'server_port': settings.server_port,
        **await _user_ctx(request, user),
    })


@router.get('/users')
async def users_page(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'users')
    if denied: return denied
    return templates.TemplateResponse(request, 'users.html', {
        'pages': PAGES, **await _user_ctx(request, user),
    })
