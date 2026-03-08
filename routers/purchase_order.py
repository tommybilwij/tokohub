"""Pesanan Pembelian (Purchase Order) API routes."""

import aiomysql
from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response, JSONResponse

from dependencies import get_db
from services.po_service import (
    get_vendor_items, get_sales_data, get_sales_monthly, get_stock_balances,
    save_pesanan, get_po_list, get_po_detail, delete_po, export_po_csv,
)

router = APIRouter()


@router.get('/api/po/vendor-items')
async def api_vendor_items(suppid: str, db: aiomysql.Pool = Depends(get_db)):
    return await get_vendor_items(db, suppid)


@router.get('/api/po/sales-data')
async def api_sales_data(suppid: str, date_from: str, date_to: str,
                         db: aiomysql.Pool = Depends(get_db)):
    data = await get_sales_data(db, suppid, date_from, date_to)
    return data


@router.get('/api/po/sales-monthly')
async def api_sales_monthly(suppid: str, date_from: str, date_to: str,
                            db: aiomysql.Pool = Depends(get_db)):
    return await get_sales_monthly(db, suppid, date_from, date_to)


@router.get('/api/po/stock-balance')
async def api_stock_balance(suppid: str, db: aiomysql.Pool = Depends(get_db)):
    return await get_stock_balances(db, suppid)


@router.post('/api/po/save')
async def api_save_po(request: Request, db: aiomysql.Pool = Depends(get_db)):
    body = await request.json()
    result = await save_pesanan(
        db,
        suppid=body['suppid'],
        items=body['items'],
        order_date=body['order_date'],
        date_from=body['date_from'],
        date_to=body['date_to'],
        created_by=body.get('created_by', ''),
    )
    if 'error' in result:
        return JSONResponse(result, status_code=400)
    return result


@router.get('/api/po/list')
async def api_po_list(request: Request, db: aiomysql.Pool = Depends(get_db)):
    params = request.query_params
    page = int(params.get('page', 1))
    items, total = await get_po_list(
        db, page=page,
        date_from=params.get('date_from'),
        date_to=params.get('date_to'),
        supplier=params.get('supplier'),
    )
    return {'items': items, 'total': total}


@router.get('/api/po/{po_number}')
async def api_po_detail(po_number: str, db: aiomysql.Pool = Depends(get_db)):
    detail = await get_po_detail(db, po_number)
    if 'error' in detail:
        return JSONResponse(detail, status_code=404)
    return detail


@router.delete('/api/po/{po_number}')
async def api_delete_po(po_number: str, db: aiomysql.Pool = Depends(get_db)):
    result = await delete_po(db, po_number)
    if 'error' in result:
        return JSONResponse(result, status_code=404)
    return result


@router.get('/api/po/{po_number}/export')
async def api_export_po(po_number: str, format: str = 'csv',
                        db: aiomysql.Pool = Depends(get_db)):
    if format == 'csv':
        content, filename = await export_po_csv(db, po_number)
        if content is None:
            return JSONResponse({'error': filename}, status_code=404)
        return Response(
            content=content,
            media_type='text/csv',
            headers={'Content-Disposition': f'attachment; filename={filename}'},
        )
    return JSONResponse({'error': 'Format not supported'}, status_code=400)
