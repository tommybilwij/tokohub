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
    get_price_change_report,
    get_price_change_from_snapshots,
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
        update_purch_price = data.get('update_purch_price', True)
        lock_history = data.get('lock_history', True)
        result = await commit_price_change(db, items, userid=user['username'] if user else '',
                                           update_purch_price=update_purch_price,
                                           lock_history=lock_history)
        return result
    except Exception as e:
        logger.exception("Price change commit failed")
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
