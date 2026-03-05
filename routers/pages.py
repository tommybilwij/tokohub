"""HTML page routes."""

import aiomysql
from fastapi import APIRouter, Request, Depends
from fastapi.templating import Jinja2Templates

from dependencies import get_db, get_templates
from services.alias_service import list_aliases
from services.po_service import get_po_history
from services.lan_auth import get_local_ip
from config import settings

router = APIRouter()


@router.get('/')
async def index():
    from fastapi.responses import RedirectResponse
    return RedirectResponse('/scanner')


@router.get('/setup')
async def setup_page(request: Request, templates: Jinja2Templates = Depends(get_templates)):
    return templates.TemplateResponse(request, 'setup.html')


@router.get('/entry')
async def entry_page(request: Request, templates: Jinja2Templates = Depends(get_templates)):
    return templates.TemplateResponse(request, 'receipt_form.html')


@router.get('/receipt/new')
async def receipt_new(request: Request, templates: Jinja2Templates = Depends(get_templates)):
    return templates.TemplateResponse(request, 'receipt_form.html')


@router.get('/aliases')
async def aliases_page(
    request: Request,
    page: int = 1,
    db: aiomysql.Pool = Depends(get_db),
    templates: Jinja2Templates = Depends(get_templates),
):
    rows, total = await list_aliases(db, page=page)
    return templates.TemplateResponse(request, 'aliases.html', {
        'aliases': rows, 'total': total, 'page': page,
    })


@router.get('/history')
async def history_page(
    request: Request,
    page: int = 1,
    db: aiomysql.Pool = Depends(get_db),
    templates: Jinja2Templates = Depends(get_templates),
):
    rows, total = await get_po_history(db, page=page)
    return templates.TemplateResponse(request, 'history.html', {
        'orders': rows, 'total': total, 'page': page,
    })


@router.get('/scanner')
async def scanner_page(request: Request, templates: Jinja2Templates = Depends(get_templates)):
    return templates.TemplateResponse(request, 'scanner.html')


@router.get('/sales-history')
async def sales_history_page(request: Request, templates: Jinja2Templates = Depends(get_templates)):
    return templates.TemplateResponse(request, 'sales_history.html')


@router.get('/settings')
async def settings_page(request: Request, templates: Jinja2Templates = Depends(get_templates)):
    return templates.TemplateResponse(request, 'settings.html', {
        'lan_mode': settings.lan_mode,
        'local_ip': get_local_ip(),
        'server_port': settings.server_port,
    })
