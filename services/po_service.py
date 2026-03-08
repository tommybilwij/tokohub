"""Pesanan Pembelian (Purchase Order) service."""

import csv
import io
import math
from datetime import datetime, timedelta, date

from services.db import execute_query, execute_single, execute_modify

_KASSA_IDS = ('002', '003', '004')


async def get_vendor_items(pool, suppid: str) -> list[dict]:
    """Get all active stock items for a vendor."""
    rows = await execute_query(
        pool,
        """SELECT artno, artpabrik, artname, packing, satbesar, satkecil, hbelibsr
           FROM stock WHERE suppid = %s AND isactive = 1
           ORDER BY artname""",
        (suppid,),
    )
    return [
        {
            'artno': r['artno'],
            'artpabrik': r['artpabrik'] or '',
            'artname': r['artname'] or '',
            'packing': float(r['packing'] or 1),
            'satbesar': r['satbesar'] or '',
            'satkecil': r['satkecil'] or '',
            'hbelibsr': float(r['hbelibsr'] or 0),
        }
        for r in rows
    ]


async def _sl_table_names(pool, dt_from: str, dt_to: str) -> list[str]:
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
        pool,
        f"SELECT TABLE_NAME FROM information_schema.TABLES "
        f"WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ({placeholders})",
        tuple(candidates),
    )
    return [r['TABLE_NAME'] for r in rows]


async def get_sales_data(pool, suppid: str, date_from: str, date_to: str) -> dict:
    """Get aggregated sales qty per item for a vendor in a date range.

    Returns dict: {artno: total_qty_sold_in_kecil}
    """
    # Get artnos for this vendor
    items = await execute_query(
        pool,
        "SELECT artno FROM stock WHERE suppid = %s AND isactive = 1",
        (suppid,),
    )
    if not items:
        return {}

    artnos = [r['artno'] for r in items]
    tables = await _sl_table_names(pool, date_from, date_to)
    if not tables:
        return {}

    # Build UNION ALL across sl tables
    unions = ' UNION ALL '.join(
        f"SELECT artno, qty FROM `{t}`" for t in tables
    )

    art_placeholders = ','.join(['%s'] * len(artnos))
    sql = (
        f"SELECT s.artno, SUM(s.qty) AS total_qty "
        f"FROM ({unions}) s "
        f"WHERE s.artno IN ({art_placeholders}) "
        f"GROUP BY s.artno"
    )

    rows = await execute_query(pool, sql, tuple(artnos))
    return {r['artno']: float(r['total_qty'] or 0) for r in rows}


async def get_sales_monthly(pool, suppid: str, date_from: str, date_to: str) -> dict:
    """Get per-month sales qty per item for a vendor.

    Returns dict: {artno: {"2026-01": qty_kcl, "2026-02": qty_kcl, ...}}
    Also returns 'months' list sorted chronologically.
    """
    items = await execute_query(
        pool,
        "SELECT artno FROM stock WHERE suppid = %s AND isactive = 1",
        (suppid,),
    )
    if not items:
        return {'items': {}, 'months': []}

    artnos = [r['artno'] for r in items]

    # Group sl tables by month
    d_from = datetime.strptime(date_from[:10], '%Y-%m-%d').date()
    d_to = datetime.strptime(date_to[:10], '%Y-%m-%d').date()

    # Build month list
    months = []
    d = d_from.replace(day=1)
    while d <= d_to:
        months.append(d.strftime('%Y-%m'))
        if d.month == 12:
            d = d.replace(year=d.year + 1, month=1)
        else:
            d = d.replace(month=d.month + 1)

    art_placeholders = ','.join(['%s'] * len(artnos))
    result = {}

    for month_str in months:
        y, m = month_str.split('-')
        m_start = date(int(y), int(m), 1)
        if int(m) == 12:
            m_end = date(int(y) + 1, 1, 1) - timedelta(days=1)
        else:
            m_end = date(int(y), int(m) + 1, 1) - timedelta(days=1)
        # Clamp to requested range
        eff_start = max(m_start, d_from)
        eff_end = min(m_end, d_to)

        tables = await _sl_table_names(pool, eff_start.isoformat(), eff_end.isoformat())
        if not tables:
            continue

        unions = ' UNION ALL '.join(
            f"SELECT artno, qty FROM `{t}`" for t in tables
        )
        sql = (
            f"SELECT s.artno, SUM(s.qty) AS total_qty "
            f"FROM ({unions}) s "
            f"WHERE s.artno IN ({art_placeholders}) "
            f"GROUP BY s.artno"
        )
        rows = await execute_query(pool, sql, tuple(artnos))
        for r in rows:
            artno = r['artno']
            if artno not in result:
                result[artno] = {}
            result[artno][month_str] = float(r['total_qty'] or 0)

    return {'items': result, 'months': months}


async def get_stock_balances(pool, suppid: str) -> dict:
    """Get current stock balances for all items of a vendor.

    Returns dict: {artno: total_curqty}
    """
    rows = await execute_query(
        pool,
        """SELECT b.artno, SUM(b.curqty) AS curqty
           FROM stlastbal b
           JOIN stock s ON s.artno = b.artno
           WHERE s.suppid = %s AND s.isactive = 1
           GROUP BY b.artno""",
        (suppid,),
    )
    return {r['artno']: float(r['curqty'] or 0) for r in rows}


async def get_item_po_data(pool, artno: str, date_from: str, date_to: str) -> dict:
    """Get sales monthly + stock for a single artno (any supplier)."""
    d_from = datetime.strptime(date_from[:10], '%Y-%m-%d').date()
    d_to = datetime.strptime(date_to[:10], '%Y-%m-%d').date()

    months = []
    d = d_from.replace(day=1)
    while d <= d_to:
        months.append(d.strftime('%Y-%m'))
        if d.month == 12:
            d = d.replace(year=d.year + 1, month=1)
        else:
            d = d.replace(month=d.month + 1)

    monthly = {}
    for month_str in months:
        y, m = month_str.split('-')
        m_start = date(int(y), int(m), 1)
        if int(m) == 12:
            m_end = date(int(y) + 1, 1, 1) - timedelta(days=1)
        else:
            m_end = date(int(y), int(m) + 1, 1) - timedelta(days=1)
        eff_start = max(m_start, d_from)
        eff_end = min(m_end, d_to)

        tables = await _sl_table_names(pool, eff_start.isoformat(), eff_end.isoformat())
        if not tables:
            continue
        unions = ' UNION ALL '.join(f"SELECT artno, qty FROM `{t}`" for t in tables)
        sql = f"SELECT SUM(s.qty) AS total_qty FROM ({unions}) s WHERE s.artno = %s"
        rows = await execute_query(pool, sql, (artno,))
        if rows and rows[0]['total_qty']:
            monthly[month_str] = float(rows[0]['total_qty'])

    # Stock balance (no supplier filter)
    rows = await execute_query(
        pool,
        "SELECT SUM(curqty) AS curqty FROM stlastbal WHERE artno = %s",
        (artno,),
    )
    stock_qty = float(rows[0]['curqty'] or 0) if rows and rows[0]['curqty'] else 0

    return {'monthly': monthly, 'stock': stock_qty}


async def _generate_po_number(cursor, order_date: date) -> str:
    """Generate PO number: PP{YYMMDD}{5-digit-seq}."""
    prefix = 'PP' + order_date.strftime('%y%m%d')
    await cursor.execute(
        "SELECT po_number FROM tokohub.pesanan_pembelian "
        "WHERE po_number LIKE %s ORDER BY po_number DESC LIMIT 1",
        (prefix + '%',),
    )
    row = await cursor.fetchone()
    if row:
        last_seq = int(row[0][len(prefix):])
        seq = last_seq + 1
    else:
        seq = 1
    return f'{prefix}{seq:05d}'


async def save_pesanan(pool, suppid: str, items: list[dict],
                       order_date: str, date_from: str, date_to: str,
                       created_by: str) -> dict:
    """Save a pesanan pembelian.

    items: list of {artno, artpabrik, artname, packing, satbesar, satkecil, qty_order, hbelibsr}
    qty_order is in sat besar.
    """
    od = datetime.strptime(order_date, '%Y-%m-%d').date()

    # Filter items with any order qty
    def _has_order(it):
        packing = float(it.get('packing', 1)) or 1
        bsr = float(it.get('qty_order', 0))
        rem = float(it.get('qty_order_kcl_remainder', 0))
        return (bsr * packing + rem) > 0

    order_items = [it for it in items if _has_order(it)]
    if not order_items:
        return {'error': 'Tidak ada item dengan qty > 0'}

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            po_number = await _generate_po_number(cur, od)

            await cur.execute(
                """INSERT INTO tokohub.pesanan_pembelian
                   (po_number, suppid, tgl_pesanan, date_from, date_to, total_items, created_by)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (po_number, suppid, order_date, date_from, date_to,
                 len(order_items), created_by),
            )

            for it in order_items:
                qty_bsr = float(it.get('qty_order', 0))
                packing = float(it.get('packing', 1)) or 1
                rem_kcl = float(it.get('qty_order_kcl_remainder', 0))
                qty_kcl = qty_bsr * packing + rem_kcl
                await cur.execute(
                    """INSERT INTO tokohub.pesanan_pembelian_detail
                       (po_number, artno, artpabrik, artname, packing, satbesar, satkecil,
                        qty_order, qty_order_kcl, hbelibsr)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (po_number, it['artno'], it.get('artpabrik', ''),
                     it.get('artname', ''), packing,
                     it.get('satbesar', ''), it.get('satkecil', ''),
                     qty_bsr, qty_kcl, float(it.get('hbelibsr', 0))),
                )

            await conn.commit()

    return {'ok': True, 'po_number': po_number, 'total_items': len(order_items)}


async def update_pesanan(pool, po_number: str, items: list[dict],
                         order_date: str, date_from: str, date_to: str) -> dict:
    """Update an existing pesanan pembelian (replace all detail lines)."""
    header = await execute_single(
        pool,
        "SELECT id FROM tokohub.pesanan_pembelian WHERE po_number = %s",
        (po_number,),
    )
    if not header:
        return {'error': 'Pesanan tidak ditemukan'}

    def _has_order(it):
        packing = float(it.get('packing', 1)) or 1
        bsr = float(it.get('qty_order', 0))
        rem = float(it.get('qty_order_kcl_remainder', 0))
        return (bsr * packing + rem) > 0

    order_items = [it for it in items if _has_order(it)]
    if not order_items:
        return {'error': 'Tidak ada item dengan qty > 0'}

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            # Delete old detail lines
            await cur.execute(
                "DELETE FROM tokohub.pesanan_pembelian_detail WHERE po_number = %s",
                (po_number,),
            )

            # Update header
            await cur.execute(
                """UPDATE tokohub.pesanan_pembelian
                   SET tgl_pesanan = %s, date_from = %s, date_to = %s, total_items = %s
                   WHERE po_number = %s""",
                (order_date, date_from, date_to, len(order_items), po_number),
            )

            # Insert new detail lines
            for it in order_items:
                qty_bsr = float(it.get('qty_order', 0))
                packing = float(it.get('packing', 1)) or 1
                rem_kcl = float(it.get('qty_order_kcl_remainder', 0))
                qty_kcl = qty_bsr * packing + rem_kcl
                await cur.execute(
                    """INSERT INTO tokohub.pesanan_pembelian_detail
                       (po_number, artno, artpabrik, artname, packing, satbesar, satkecil,
                        qty_order, qty_order_kcl, hbelibsr)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (po_number, it['artno'], it.get('artpabrik', ''),
                     it.get('artname', ''), packing,
                     it.get('satbesar', ''), it.get('satkecil', ''),
                     qty_bsr, qty_kcl, float(it.get('hbelibsr', 0))),
                )

            await conn.commit()

    return {'ok': True, 'po_number': po_number, 'total_items': len(order_items)}


async def get_po_list(pool, page: int = 1, per_page: int = 20,
                      date_from: str = None, date_to: str = None,
                      supplier: str = None) -> tuple[list, int]:
    """Get paginated list of pesanan pembelian."""
    where = []
    params = []

    if date_from:
        where.append("p.tgl_pesanan >= %s")
        params.append(date_from)
    if date_to:
        where.append("p.tgl_pesanan <= %s")
        params.append(date_to)
    if supplier:
        where.append("p.suppid = %s")
        params.append(supplier)

    where_sql = (' WHERE ' + ' AND '.join(where)) if where else ''

    count_row = await execute_single(
        pool,
        f"SELECT COUNT(*) AS cnt FROM tokohub.pesanan_pembelian p{where_sql}",
        tuple(params),
    )
    total = count_row['cnt'] if count_row else 0

    offset = (page - 1) * per_page
    rows = await execute_query(
        pool,
        f"""SELECT p.po_number, p.suppid, p.tgl_pesanan, p.date_from, p.date_to,
                   p.total_items, p.created_by, p.created_at,
                   v.name AS supplier_name
            FROM tokohub.pesanan_pembelian p
            LEFT JOIN vendor v ON v.id = p.suppid
            {where_sql}
            ORDER BY p.created_at DESC
            LIMIT %s OFFSET %s""",
        tuple(params) + (per_page, offset),
    )

    items = []
    for r in rows:
        items.append({
            'po_number': r['po_number'],
            'suppid': r['suppid'],
            'tgl_pesanan': str(r['tgl_pesanan']) if r['tgl_pesanan'] else '',
            'date_from': str(r['date_from']) if r['date_from'] else '',
            'date_to': str(r['date_to']) if r['date_to'] else '',
            'total_items': r['total_items'],
            'supplier_name': r['supplier_name'] or r['suppid'],
            'created_by': r['created_by'] or '',
            'created_at': str(r['created_at']) if r['created_at'] else '',
        })

    return items, total


async def get_po_detail(pool, po_number: str) -> dict:
    """Get detail of a saved pesanan."""
    header = await execute_single(
        pool,
        """SELECT p.po_number, p.suppid, p.tgl_pesanan, p.date_from, p.date_to,
                  p.total_items, p.created_by, p.created_at,
                  v.name AS supplier_name
           FROM tokohub.pesanan_pembelian p
           LEFT JOIN vendor v ON v.id = p.suppid
           WHERE p.po_number = %s""",
        (po_number,),
    )
    if not header:
        return {'error': 'Pesanan tidak ditemukan'}

    lines = await execute_query(
        pool,
        """SELECT artno, artpabrik, artname, packing, satbesar, satkecil,
                  qty_order, qty_order_kcl, hbelibsr
           FROM tokohub.pesanan_pembelian_detail
           WHERE po_number = %s ORDER BY id""",
        (po_number,),
    )

    return {
        'po_number': header['po_number'],
        'suppid': header['suppid'],
        'supplier_name': header['supplier_name'] or header['suppid'],
        'tgl_pesanan': str(header['tgl_pesanan']) if header['tgl_pesanan'] else '',
        'date_from': str(header['date_from']) if header['date_from'] else '',
        'date_to': str(header['date_to']) if header['date_to'] else '',
        'total_items': header['total_items'],
        'created_by': header['created_by'] or '',
        'lines': [
            {
                'artno': l['artno'],
                'artpabrik': l['artpabrik'] or '',
                'artname': l['artname'] or '',
                'packing': float(l['packing'] or 1),
                'satbesar': l['satbesar'] or '',
                'satkecil': l['satkecil'] or '',
                'qty_order': float(l['qty_order'] or 0),
                'qty_order_kcl': float(l['qty_order_kcl'] or 0),
                'hbelibsr': float(l['hbelibsr'] or 0),
            }
            for l in lines
        ],
    }


async def delete_po(pool, po_number: str) -> dict:
    """Delete a pesanan pembelian."""
    header = await execute_single(
        pool,
        "SELECT id FROM tokohub.pesanan_pembelian WHERE po_number = %s",
        (po_number,),
    )
    if not header:
        return {'error': 'Pesanan tidak ditemukan'}

    await execute_modify(
        pool,
        "DELETE FROM tokohub.pesanan_pembelian_detail WHERE po_number = %s",
        (po_number,),
    )
    await execute_modify(
        pool,
        "DELETE FROM tokohub.pesanan_pembelian WHERE po_number = %s",
        (po_number,),
    )
    return {'ok': True}


async def export_po_csv(pool, po_number: str) -> tuple[str, str]:
    """Export PO to CSV. Returns (csv_content, filename)."""
    detail = await get_po_detail(pool, po_number)
    if 'error' in detail:
        return None, detail['error']

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(['No', 'Artno', 'Barcode', 'Nama Barang', 'Isi',
                     'Qty Order', 'Satuan Besar', 'Qty Kcl', 'Satuan Kecil', 'H.Beli Bsr'])

    for i, line in enumerate(detail['lines'], 1):
        writer.writerow([
            i,
            line['artno'],
            f"'{line['artpabrik']}" if line['artpabrik'] else '',
            line['artname'],
            int(line['packing']),
            line['qty_order'],
            line['satbesar'],
            line['qty_order_kcl'],
            line['satkecil'],
            line['hbelibsr'],
        ])

    filename = f"pesanan_{po_number}.csv"
    return buf.getvalue(), filename
