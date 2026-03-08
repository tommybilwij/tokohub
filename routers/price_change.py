"""Price change (Perubahan Harga) API routes."""

import logging
from datetime import date

import aiomysql
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from dependencies import get_db, get_current_user
from services.price_change_service import (
    get_stock_prices,
    commit_price_change,
    update_ph,
    get_price_change_report,
    get_price_change_from_snapshots,
    get_ph_history,
    get_ph_detail,
    toggle_ph_lock,
    delete_ph,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post('/api/price-change/stock-prices')
async def api_stock_prices(request: Request, db: aiomysql.Pool = Depends(get_db)):
    """Get current stock prices for given artnos."""
    data = await request.json()
    artnos = data.get('artnos', [])
    if not artnos:
        return {'items': {}}
    prices = await get_stock_prices(db, artnos)
    return {'items': prices}


@router.post('/api/price-change/commit')
async def api_commit_price_change(
    request: Request,
    db: aiomysql.Pool = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Commit price changes."""
    data = await request.json()
    items = data.get('items', [])
    if not items:
        return JSONResponse({'error': 'No items'}, status_code=400)
    try:
        uraian = (data.get('uraian') or '').strip()[:50]
        result = await commit_price_change(db, items, userid=user['username'] if user else '', uraian=uraian)
        return result
    except Exception as e:
        logger.exception("Price change commit failed")
        return JSONResponse({'error': str(e)}, status_code=500)


@router.post('/api/ph/{ph_number}/update')
async def api_ph_update(
    ph_number: str,
    request: Request,
    db: aiomysql.Pool = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Update an existing price change."""
    data = await request.json()
    items = data.get('items', [])
    if not items:
        return JSONResponse({'error': 'No items'}, status_code=400)
    try:
        uraian = (data.get('uraian') or '').strip()[:50]
        result = await update_ph(db, ph_number, items,
                                 userid=user['username'] if user else '', uraian=uraian)
        if 'error' in result:
            return JSONResponse(result, status_code=400)
        return result
    except Exception as e:
        logger.exception("Price change update failed")
        return JSONResponse({'error': str(e)}, status_code=500)


@router.get('/api/ph/list')
async def api_ph_list(
    page: int = 1,
    date_from: str = None,
    date_to: str = None,
    db: aiomysql.Pool = Depends(get_db),
):
    rows, total = await get_ph_history(
        db, page=page, date_from=date_from or None, date_to=date_to or None,
    )
    items = []
    for r in rows:
        d = dict(r)
        d['tglberlaku'] = d['tglberlaku'].strftime('%Y-%m-%d') if d['tglberlaku'] else ''
        items.append(d)
    return {'items': items, 'total': total, 'page': page}


@router.get('/api/ph/{ph_number}')
async def api_ph_detail(ph_number: str, db: aiomysql.Pool = Depends(get_db)):
    result = await get_ph_detail(db, ph_number)
    if not result:
        return JSONResponse({'error': 'Not found'}, status_code=404)
    return result


@router.post('/api/ph/{ph_number}/toggle-lock')
async def api_ph_toggle_lock(ph_number: str, db: aiomysql.Pool = Depends(get_db)):
    result = await toggle_ph_lock(db, ph_number)
    if 'error' in result:
        return JSONResponse(result, status_code=404)
    return result


@router.delete('/api/ph/{ph_number}')
async def api_ph_delete(ph_number: str, db: aiomysql.Pool = Depends(get_db)):
    try:
        result = await delete_ph(db, ph_number)
        if 'error' in result:
            return JSONResponse(result, status_code=400)
        return result
    except Exception as e:
        logger.exception("Price change delete failed")
        return JSONResponse({'error': str(e)}, status_code=500)


@router.get('/api/price-change/report')
async def api_price_change_report(
    report_date: str | None = None,
    db: aiomysql.Pool = Depends(get_db),
):
    """Get price change report for a date."""
    d = date.fromisoformat(report_date) if report_date else date.today()
    manual = await get_price_change_report(db, d)
    from_faktur = await get_price_change_from_snapshots(db, d)
    return {'date': d.isoformat(), 'manual': manual, 'from_faktur': from_faktur}
