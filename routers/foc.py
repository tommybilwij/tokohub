"""FOC (Barang Diskon) history routes."""

import aiomysql
from fastapi import APIRouter, Depends, Request

from dependencies import get_db
from services.db import execute_query

router = APIRouter()


def _parse_date_range(raw_from: str, raw_to: str):
    """Parse from/to date strings (YYYY-MM-DD)."""
    raw_from = raw_from.strip()[:10]
    raw_to = raw_to.strip()[:10]
    if not raw_from or not raw_to:
        return None, None
    return raw_from, raw_to


@router.get('/api/foc/history')
async def api_foc_history(request: Request, db: aiomysql.Pool = Depends(get_db)):
    raw_from = request.query_params.get('from', '')
    raw_to = request.query_params.get('to', '')
    dt_from, dt_to = _parse_date_range(raw_from, raw_to)
    if not dt_from:
        return []

    rows = await execute_query(
        db,
        """SELECT s.noindex, s.tanggal, s.stockid, s.artname, s.artpabrik,
                  s.qty, s.packing, s.satuanbsr, s.satuankcl,
                  s.beli, s.qtybonus, s.nofaktur, s.suppid,
                  v.name AS suppname
           FROM sthist s
           LEFT JOIN vendor v ON v.id = s.suppid
           WHERE s.qtybonus > 0
             AND s.tanggal BETWEEN %s AND %s
           ORDER BY s.tanggal DESC, s.noindex DESC""",
        (dt_from, dt_to)
    )
    for r in rows:
        if r.get('tanggal') is not None:
            r['tanggal'] = str(r['tanggal'])
        for k in ('qty', 'packing', 'beli', 'qtybonus'):
            if r.get(k) is not None:
                r[k] = float(r[k])
    return rows
