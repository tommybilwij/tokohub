"""Stock search, vendor, and user API routes."""

import aiomysql
from fastapi import APIRouter, Depends, Query

from dependencies import get_db
from services.db import execute_query
from services.stock_search import search_stock

router = APIRouter()


@router.get('/api/stock/balance/{artno}')
async def api_stock_balance(artno: str, db: aiomysql.Pool = Depends(get_db)):
    rows = await execute_query(
        db,
        "SELECT warehouseid, curqty FROM stlastbal WHERE artno = %s",
        (artno,)
    )
    return rows


@router.get('/api/stock/search')
async def api_stock_search(
    q: str = '',
    limit: int | None = None,
    min_score: int | None = None,
    score_against: str = '',
    mode: str = '',
    db: aiomysql.Pool = Depends(get_db),
):
    query = q.strip()
    if not query:
        return []
    from services import app_settings
    # Use mode-specific search settings from DB
    if mode == 'pc':
        limit = limit or await app_settings.get_int(db, 'pc_top_n')
        min_score = min_score if min_score is not None else await app_settings.get_int(db, 'pc_min_score')
    elif mode == 'po':
        limit = limit or await app_settings.get_int(db, 'po_top_n')
        min_score = min_score if min_score is not None else await app_settings.get_int(db, 'po_min_score')
    else:
        limit = limit or await app_settings.get_int(db, 'fuzzy_top_n')
        min_score = min_score if min_score is not None else await app_settings.get_int(db, 'fuzzy_min_score')
    results = await search_stock(
        db, query,
        top_n=limit,
        min_score=min_score,
        score_against=score_against.strip() or None,
    )
    return results


@router.get('/api/vendors')
async def api_vendors(db: aiomysql.Pool = Depends(get_db)):
    rows = await execute_query(
        db,
        "SELECT id, name, address, city, phone FROM vendor WHERE isactive = 1 ORDER BY name"
    )
    return rows


@router.get('/api/users')
async def api_users(db: aiomysql.Pool = Depends(get_db)):
    rows = await execute_query(
        db,
        "SELECT nouser, usrname FROM myposse_users.users ORDER BY nouser"
    )
    return rows
