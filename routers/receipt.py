"""Receipt upload, matching, alias, and FP routes."""

import os
import logging
from datetime import date
from pathlib import Path

import aiomysql
from fastapi import APIRouter, Depends, UploadFile, File
from fastapi.responses import JSONResponse

from config import settings
from dependencies import get_db
from models.receipt import MatchRequest, AliasCreate, AliasDelete, FPPreviewRequest, FPCommitRequest, FPUpdateRequest
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
        items = await extract_lines(db, filepath)
        return {'items': items}
    except Exception as e:
        logger.exception("OCR failed")
        return JSONResponse({'error': f'OCR processing failed: {e}'}, status_code=500)
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
async def preview_fp(data: FPPreviewRequest, db: aiomysql.Pool = Depends(get_db)):
    supplier_id = data.supplier_id.strip()
    items = [item.model_dump() for item in data.items]
    order_date = date.fromisoformat(data.order_date) if data.order_date else date.today()
    due_date = date.fromisoformat(data.due_date) if data.due_date else None
    uraian = (data.uraian or '').strip()[:50] or None

    if not supplier_id or not items:
        return JSONResponse({'error': 'supplier_id and items are required'}, status_code=400)

    try:
        from services.fp_service import preview_fp as _preview
        result = await _preview(db, supplier_id, items, order_date, shipping_cost=data.shipping_cost)
        return result
    except Exception as e:
        logger.exception("FP preview failed")
        return JSONResponse({'error': str(e)}, status_code=500)


@router.post('/receipt/commit')
async def commit_fp(data: FPCommitRequest, db: aiomysql.Pool = Depends(get_db)):
    supplier_id = data.supplier_id.strip()
    userid = data.userid.strip()
    items = [item.model_dump() for item in data.items]
    order_date = date.fromisoformat(data.order_date) if data.order_date else date.today()
    due_date = date.fromisoformat(data.due_date) if data.due_date else None
    uraian = (data.uraian or '').strip()[:50] or None

    if not supplier_id or not items or not userid:
        return JSONResponse({'error': 'supplier_id, userid, and items are required'}, status_code=400)

    try:
        from services.fp_service import commit_fp as _commit
        result = await _commit(db, supplier_id, items, order_date, userid=userid, shipping_cost=data.shipping_cost, update_price=data.update_price, due_date=due_date, uraian=uraian)
        return result
    except Exception as e:
        logger.exception("FP commit failed")
        return JSONResponse({'error': str(e)}, status_code=500)


@router.get('/api/fp/list')
async def api_fp_list(
    page: int = 1,
    date_from: str = None,
    date_to: str = None,
    supplier: str = None,
    db: aiomysql.Pool = Depends(get_db),
):
    from services.fp_service import get_fp_history
    rows, total = await get_fp_history(
        db, page=page, date_from=date_from or None,
        date_to=date_to or None, supplier=supplier or None,
    )
    items = []
    for r in rows:
        d = dict(r)
        d['tglfaktur'] = d['tglfaktur'].strftime('%Y-%m-%d') if d['tglfaktur'] else ''
        d['jlhfaktur'] = float(d['jlhfaktur'] or 0)
        items.append(d)
    return {'items': items, 'total': total, 'page': page}


@router.get('/api/fp/{fp_number}')
async def get_fp(fp_number: str, db: aiomysql.Pool = Depends(get_db)):
    from services.fp_service import get_fp_detail
    result = await get_fp_detail(db, fp_number)
    if not result:
        return JSONResponse({'error': 'Faktur not found'}, status_code=404)
    return result


@router.get('/api/fp/{fp_number}/snapshot')
async def get_fp_snapshot(fp_number: str, db: aiomysql.Pool = Depends(get_db)):
    from services.snapshot_service import get_snapshot
    result = await get_snapshot(db, fp_number)
    if not result:
        return JSONResponse({'error': 'No snapshot found'}, status_code=404)
    return result


@router.post('/api/fp/{fp_number}/toggle-lock')
async def toggle_fp_lock(fp_number: str, db: aiomysql.Pool = Depends(get_db)):
    from services.fp_service import toggle_fp_lock as _toggle
    result = await _toggle(db, fp_number)
    if 'error' in result:
        return JSONResponse(result, status_code=404)
    return result


@router.post('/api/fp/{fp_number}/toggle-update-price')
async def toggle_fp_update_price(fp_number: str, db: aiomysql.Pool = Depends(get_db)):
    from services.fp_service import toggle_fp_update_price as _toggle
    result = await _toggle(db, fp_number)
    if 'error' in result:
        return JSONResponse(result, status_code=400)
    return result


@router.delete('/api/fp/{fp_number}')
async def delete_fp(fp_number: str, db: aiomysql.Pool = Depends(get_db)):
    from services.fp_service import delete_fp as _delete
    try:
        result = await _delete(db, fp_number)
        if 'error' in result:
            return JSONResponse(result, status_code=400)
        return result
    except Exception as e:
        logger.exception("Faktur delete failed")
        return JSONResponse({'error': str(e)}, status_code=500)


@router.post('/receipt/update')
async def update_fp(data: FPUpdateRequest, db: aiomysql.Pool = Depends(get_db)):
    supplier_id = data.supplier_id.strip()
    userid = data.userid.strip()
    fp_number = data.fp_number.strip()
    items = [item.model_dump() for item in data.items]
    order_date = date.fromisoformat(data.order_date) if data.order_date else date.today()
    due_date = date.fromisoformat(data.due_date) if data.due_date else None
    uraian = (data.uraian or '').strip()[:50] or None

    if not supplier_id or not items or not userid or not fp_number:
        return JSONResponse({'error': 'fp_number, supplier_id, userid, and items are required'}, status_code=400)

    try:
        from services.fp_service import update_fp as _update
        result = await _update(db, fp_number, supplier_id, items, order_date, userid=userid, shipping_cost=data.shipping_cost, update_price=data.update_price, due_date=due_date, uraian=uraian)
        return result
    except Exception as e:
        logger.exception("Faktur update failed")
        return JSONResponse({'error': str(e)}, status_code=500)
