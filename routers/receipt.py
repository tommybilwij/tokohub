"""Receipt upload, matching, alias, and PO routes."""

import os
import logging
from datetime import date
from pathlib import Path

import aiomysql
from fastapi import APIRouter, Depends, UploadFile, File
from fastapi.responses import JSONResponse

from config import settings
from dependencies import get_db
from models.receipt import MatchRequest, AliasCreate, AliasDelete, POPreviewRequest, POCommitRequest
from services.stock_search import search_stock

logger = logging.getLogger(__name__)

router = APIRouter()


def _allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in settings.allowed_extensions


@router.post('/receipt/upload-photo')
async def upload_photo(photo: UploadFile = File(...), db: aiomysql.Pool = Depends(get_db)):
    if not photo.filename or not _allowed_file(photo.filename):
        return JSONResponse({'error': 'Invalid file type. Use PNG or JPG.'}, status_code=400)

    filename = Path(photo.filename).name
    filepath = os.path.join(str(settings.upload_folder), filename)

    content = await photo.read()
    with open(filepath, 'wb') as f:
        f.write(content)

    try:
        from services.ocr import extract_lines
        items = await extract_lines(filepath)
        return {'items': items}
    except Exception as e:
        logger.exception("OCR failed")
        return JSONResponse({'error': f'OCR processing failed: {e}'}, status_code=500)
    finally:
        if os.path.exists(filepath):
            os.remove(filepath)


@router.post('/receipt/upload-csv')
async def upload_csv(file: UploadFile = File(...)):
    if not file.filename or not _allowed_file(file.filename):
        return JSONResponse({'error': 'Invalid file type. Use CSV or XLSX.'}, status_code=400)

    filename = Path(file.filename).name
    filepath = os.path.join(str(settings.upload_folder), filename)

    content = await file.read()
    with open(filepath, 'wb') as f:
        f.write(content)

    try:
        ext = filename.rsplit('.', 1)[1].lower()
        if ext == 'csv':
            from services.csv_import import parse_csv
            items = parse_csv(file_path=filepath)
        else:
            from services.csv_import import parse_excel
            items = parse_excel(file_path=filepath)
        return {'items': items}
    except Exception as e:
        logger.exception("CSV/Excel parsing failed")
        return JSONResponse({'error': f'File parsing failed: {e}'}, status_code=500)
    finally:
        if os.path.exists(filepath):
            os.remove(filepath)


@router.post('/receipt/match')
async def match_items(data: MatchRequest, db: aiomysql.Pool = Depends(get_db)):
    results = []
    for item in data.items:
        name = item.name.strip()
        barcode = item.barcode.strip()
        if not name and not barcode:
            continue

        matches = []

        # Priority 1: Try barcode match first
        if barcode:
            matches = await search_stock(db, barcode)
            if matches and matches[0].get('match_type') != 'barcode':
                matches = []

        # Priority 2: Fall back to name (fuzzy) match
        if not matches and name:
            matches = await search_stock(db, name)

        status = 'unmatched'
        if matches:
            if matches[0]['match_type'] in ('alias', 'barcode'):
                status = 'auto'
            elif matches[0]['score'] >= 85:
                status = 'auto'
            else:
                status = 'review'

        results.append({
            'name': name,
            'qty': item.qty,
            'price': item.price,
            'status': status,
            'matches': matches,
        })

    return {'results': results}


@router.post('/receipt/save-alias')
async def save_alias(data: AliasCreate, db: aiomysql.Pool = Depends(get_db)):
    alias_name = data.alias_name.strip()
    artno = data.artno.strip()
    userid = data.userid.strip() or 'RECEIPT_APP'

    if not alias_name or not artno:
        return JSONResponse({'error': 'alias_name and artno are required'}, status_code=400)

    from services.alias_service import save_alias as _save
    success = await _save(db, alias_name, artno, created_by=userid)
    if success:
        return {'ok': True}
    return JSONResponse({'ok': False, 'error': 'Alias already exists'}, status_code=409)


@router.post('/receipt/delete-alias')
async def delete_alias(data: AliasDelete, db: aiomysql.Pool = Depends(get_db)):
    from services.alias_service import delete_alias as _delete
    await _delete(db, data.id)
    return {'ok': True}


@router.post('/receipt/preview')
async def preview_po(data: POPreviewRequest, db: aiomysql.Pool = Depends(get_db)):
    supplier_id = data.supplier_id.strip()
    items = [item.model_dump() for item in data.items]
    order_date = date.fromisoformat(data.order_date) if data.order_date else date.today()

    if not supplier_id or not items:
        return JSONResponse({'error': 'supplier_id and items are required'}, status_code=400)

    try:
        from services.po_service import preview_po as _preview
        result = await _preview(db, supplier_id, items, order_date, shipping_cost=data.shipping_cost)
        return result
    except Exception as e:
        logger.exception("PO preview failed")
        return JSONResponse({'error': str(e)}, status_code=500)


@router.post('/receipt/commit')
async def commit_po(data: POCommitRequest, db: aiomysql.Pool = Depends(get_db)):
    supplier_id = data.supplier_id.strip()
    userid = data.userid.strip()
    items = [item.model_dump() for item in data.items]
    order_date = date.fromisoformat(data.order_date) if data.order_date else date.today()

    if not supplier_id or not items or not userid:
        return JSONResponse({'error': 'supplier_id, userid, and items are required'}, status_code=400)

    try:
        from services.po_service import commit_po as _commit
        result = await _commit(db, supplier_id, items, order_date, userid=userid, shipping_cost=data.shipping_cost)
        return result
    except Exception as e:
        logger.exception("PO commit failed")
        return JSONResponse({'error': str(e)}, status_code=500)


@router.get('/api/po/{po_number}')
async def get_po(po_number: str, db: aiomysql.Pool = Depends(get_db)):
    from services.po_service import get_po_detail
    result = await get_po_detail(db, po_number)
    if not result:
        return JSONResponse({'error': 'PO not found'}, status_code=404)
    return result
