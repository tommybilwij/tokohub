"""Sales history and export routes."""

import io
import csv
from datetime import datetime, timedelta

import aiomysql
from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response

from dependencies import get_db
from services.db import execute_query, execute_single

router = APIRouter()

_KASSA_IDS = ('002', '003', '004')


@router.get('/api/sales/departments')
async def api_departments(db: aiomysql.Pool = Depends(get_db)):
    rows = await execute_query(db, "SELECT deptid, dpdesc FROM dept ORDER BY deptid")
    return [{'id': r['deptid'], 'name': r['dpdesc']} for r in rows]


def _parse_sales_range(raw_from: str, raw_to: str):
    """Parse from/to, accepting date or datetime-local (YYYY-MM-DDTHH:MM)."""
    raw_from = raw_from.strip().replace('T', ' ')
    raw_to = raw_to.strip().replace('T', ' ')
    if not raw_from or not raw_to:
        return None, None
    if len(raw_from) == 10:
        raw_from += ' 00:00:00'
    elif len(raw_from) == 16:
        raw_from += ':00'
    if len(raw_to) == 10:
        raw_to += ' 23:59:59'
    elif len(raw_to) == 16:
        raw_to += ':59'
    return raw_from, raw_to


async def _sl_table_names(db, dt_from, dt_to):
    """Return list of existing sl* table names covering the date range."""
    d_from = datetime.strptime(dt_from[:10], '%Y-%m-%d').date()
    d_to = datetime.strptime(dt_to[:10], '%Y-%m-%d').date()

    candidates = []
    d = d_from
    while d <= d_to:
        prefix = d.strftime('%y%m%d')
        for k in _KASSA_IDS:
            candidates.append(f'sl{prefix}{k}')
        d += timedelta(days=1)

    if not candidates:
        return []

    placeholders = ','.join(['%s'] * len(candidates))
    rows = await execute_query(
        db,
        f"SELECT TABLE_NAME FROM information_schema.TABLES "
        f"WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ({placeholders})",
        tuple(candidates)
    )
    return [r['TABLE_NAME'] for r in rows]


async def _query_sales(db, dt_from, dt_to, dept=None):
    """Query sl* tables for sales in the given datetime range."""
    tables = await _sl_table_names(db, dt_from, dt_to)
    if not tables:
        return []

    unions = ' UNION ALL '.join(
        f"SELECT artno, transtime, qty, unitprc, netamount FROM `{t}`"
        for t in tables
    )
    params = [dt_from, dt_to]
    dept_filter = ''
    if dept:
        dept_ids = [d.strip() for d in dept.split(',') if d.strip()]
        if dept_ids:
            placeholders_d = ','.join(['%s'] * len(dept_ids))
            dept_filter = f' AND st.deptid IN ({placeholders_d})'
            params.extend(dept_ids)

    sql = (
        f"SELECT s.artno, st.deptid, st.artname, st.artpabrik AS barcode, s.unitprc AS hjual, "
        f"SUM(s.qty) AS total_qty, SUM(s.netamount) AS total_amount "
        f"FROM ({unions}) s "
        f"JOIN stock st ON st.artno = s.artno "
        f"WHERE s.transtime BETWEEN %s AND %s{dept_filter} "
        f"GROUP BY s.artno, st.deptid, st.artname, st.artpabrik, s.unitprc "
        f"ORDER BY total_amount DESC"
    )

    return await execute_query(db, sql, tuple(params))


# Use request directly since 'from' is a Python reserved keyword
@router.get('/api/sales/history')
async def api_sales_history(request: Request, db: aiomysql.Pool = Depends(get_db)):
    raw_from = request.query_params.get('from', '')
    raw_to = request.query_params.get('to', '')
    dt_from, dt_to = _parse_sales_range(raw_from, raw_to)
    if not dt_from:
        return []

    dept = request.query_params.get('dept', '')
    rows = await _query_sales(db, dt_from, dt_to, dept=dept or None)
    for r in rows:
        for k in ('hjual', 'total_qty', 'total_amount'):
            if r.get(k) is not None:
                r[k] = float(r[k])
    return rows


@router.get('/api/sales/export')
async def api_sales_export(request: Request, db: aiomysql.Pool = Depends(get_db)):
    raw_from = request.query_params.get('from', '')
    raw_to = request.query_params.get('to', '')
    dt_from, dt_to = _parse_sales_range(raw_from, raw_to)
    if not dt_from:
        return {'error': 'from and to are required'}

    dept = request.query_params.get('dept', '')
    rows = await _query_sales(db, dt_from, dt_to, dept=dept or None)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(['Artno', 'Barcode', 'Dept', 'Nama Barang', 'Harga Jual', 'Qty', 'Total'])
    for r in rows:
        barcode = r.get('barcode', '') or ''
        writer.writerow([
            r.get('artno', ''),
            f"'{barcode}" if barcode else '',
            r.get('deptid', ''),
            r.get('artname', ''),
            r.get('hjual', 0),
            r.get('total_qty', 0),
            r.get('total_amount', 0),
        ])

    output = buf.getvalue()
    f = raw_from.replace('T', '_').replace(':', '')
    t = raw_to.replace('T', '_').replace(':', '')
    filename = f'penjualan_{f}_{t}.csv'
    return Response(
        content=output,
        media_type='text/csv',
        headers={'Content-Disposition': f'attachment; filename={filename}'}
    )
