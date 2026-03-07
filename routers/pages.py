"""HTML page routes."""

import aiomysql
from fastapi import APIRouter, Request, Depends
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from starlette.responses import JSONResponse

from dependencies import get_db, get_templates, get_current_user
from services.alias_service import list_aliases
from services.po_service import get_po_history
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
async def index():
    return RedirectResponse('/scanner')


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


@router.get('/entry')
async def entry_page(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'entry')
    if denied: return denied
    return templates.TemplateResponse(request, 'receipt_form.html', await _user_ctx(request, user))


@router.get('/receipt/new')
async def receipt_new(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'entry')
    if denied: return denied
    return templates.TemplateResponse(request, 'receipt_form.html', await _user_ctx(request, user))


@router.get('/aliases')
async def aliases_page(
    request: Request,
    page: int = 1,
    db: aiomysql.Pool = Depends(get_db),
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'aliases')
    if denied: return denied
    rows, total = await list_aliases(db, page=page)
    return templates.TemplateResponse(request, 'aliases.html', {
        'aliases': rows, 'total': total, 'page': page, **await _user_ctx(request, user),
    })


@router.get('/history')
async def history_page(
    request: Request,
    page: int = 1,
    db: aiomysql.Pool = Depends(get_db),
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'history')
    if denied: return denied
    rows, total = await get_po_history(db, page=page)
    return templates.TemplateResponse(request, 'history.html', {
        'orders': rows, 'total': total, 'page': page, **await _user_ctx(request, user),
    })


@router.get('/scanner')
async def scanner_page(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'scanner')
    if denied: return denied
    return templates.TemplateResponse(request, 'scanner.html', await _user_ctx(request, user))


@router.get('/sales-history')
async def sales_history_page(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'sales')
    if denied: return denied
    ctx = await _user_ctx(request, user)
    pool = request.app.state.db_pool
    ctx['show_harga'] = await has_page_access(pool, user['role'], 'sales:harga')
    ctx['show_total'] = await has_page_access(pool, user['role'], 'sales:total')
    return templates.TemplateResponse(request, 'sales_history.html', ctx)


@router.get('/foc-history')
async def foc_history_page(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'foc')
    if denied: return denied
    return templates.TemplateResponse(request, 'foc_history.html', await _user_ctx(request, user))


@router.get('/price-change')
async def price_change_page(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'price_change')
    if denied: return denied
    return templates.TemplateResponse(request, 'price_change.html', await _user_ctx(request, user))


@router.get('/price-change-report')
async def price_change_report_page(
    request: Request,
    templates: Jinja2Templates = Depends(get_templates),
    user: dict = Depends(get_current_user),
):
    denied = await _check_page(request, user, 'price_report')
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
