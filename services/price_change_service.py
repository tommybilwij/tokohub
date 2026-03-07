"""Price change (Perubahan Harga) service.

Handles reading stock prices, writing price changes to
myposse.sthist (tipetrans=0) and icphg header.
"""

import json
import logging
from datetime import date
from decimal import Decimal

import aiomysql

from services.db import execute_query, execute_single, execute_modify

logger = logging.getLogger(__name__)

# Fields to read from stock for current state
_STOCK_FIELDS = (
    'artno', 'artname', 'artpabrik', 'satbesar', 'satkecil', 'packing',
    'hbelibsr', 'hbelikcl', 'hbelinetto',
    'pctdisc1', 'pctdisc2', 'pctdisc3', 'pctppn',
    'jlhdisc1', 'jlhdisc2', 'jlhdisc3', 'jlhppn',
    'hjual', 'hjual2', 'hjual3', 'hjual4', 'hjual5',
    'ispaketprc', 'over1', 'over2',
    'hjualo1', 'hjual2o1', 'hjual3o1', 'hjual4o1', 'hjual5o1',
    'hjualo2', 'hjual2o2', 'hjual3o2', 'hjual4o2', 'hjual5o2',
)


async def get_stock_prices(pool, artnos: list[str]) -> dict:
    """Get current prices from stock table for given artnos."""
    if not artnos:
        return {}
    placeholders = ','.join(['%s'] * len(artnos))
    cols = ', '.join(_STOCK_FIELDS)
    rows = await execute_query(
        pool,
        f"SELECT {cols} FROM stock WHERE artno IN ({placeholders})",
        tuple(artnos),
    )
    result = {}
    for r in rows:
        d = {k: (float(v) if isinstance(v, Decimal) else v) for k, v in dict(r).items()}
        result[d['artno']] = d
    return result


async def _generate_ph_number(cursor, order_date):
    """Generate PH number: PH{YYMMDD}{5-digit-seq}."""
    prefix = f"PH{order_date.strftime('%y%m%d')}"
    await cursor.execute(
        "SELECT nofaktur FROM sthist WHERE nofaktur LIKE %s ORDER BY nofaktur DESC LIMIT 1",
        (f"{prefix}%",)
    )
    row = await cursor.fetchone()
    if row:
        last_seq = int(row['nofaktur'][-5:])
        seq = last_seq + 1
    else:
        seq = 1
    return f"{prefix}{seq:05d}"


async def commit_price_change(pool, items: list[dict], userid: str = '',
                              update_purch_price: bool = True,
                              lock_history: bool = True) -> dict:
    """Commit price changes.

    Each item: {artno, hjual, hjual2, hjual3, hjual4, hjual5}
    Only harga jual fields are editable.

    Writes to:
    1. stock table (update hjual prices)
    2. sthist (tipetrans=0, PH record)
    3. icphg (price change header)
    """
    if not items:
        return {'error': 'No items'}

    artnos = [i['artno'] for i in items]
    before_map = await get_stock_prices(pool, artnos)

    today = date.today()

    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cursor:
            # Get and increment becreff
            await cursor.execute("SELECT newph FROM nextrec LIMIT 1 FOR UPDATE")
            nextrec = await cursor.fetchone()
            becreff = nextrec['newph']

            # Generate PH number
            ph_number = await _generate_ph_number(cursor, today)

            for item in items:
                artno = item['artno']
                stock = before_map.get(artno)
                if not stock:
                    continue

                new_hjual = float(item.get('hjual', stock['hjual']))
                new_hjual2 = float(item.get('hjual2', stock['hjual2']))
                new_hjual3 = float(item.get('hjual3', stock['hjual3']))
                new_hjual4 = float(item.get('hjual4', stock['hjual4']))
                new_hjual5 = float(item.get('hjual5', stock['hjual5']))

                old_hjual = float(stock['hjual'] or 0)

                # Calculate profit percentages
                netto = float(stock['hbelinetto'] or 0)
                def _pct(jual):
                    return round((jual - netto) / netto * 100, 2) if netto > 0 else -100
                pctprofit = _pct(new_hjual)
                pctprofit2 = _pct(new_hjual2) if new_hjual2 else -100
                pctprofit3 = _pct(new_hjual3) if new_hjual3 else -100
                pctprofit4 = _pct(new_hjual4) if new_hjual4 else -100
                pctprofit5 = _pct(new_hjual5) if new_hjual5 else -100

                # 1. Update stock table — main harga jual
                update_cols = ['hjual=%s', 'hjual2=%s', 'hjual3=%s', 'hjual4=%s', 'hjual5=%s']
                update_vals = [new_hjual, new_hjual2, new_hjual3, new_hjual4, new_hjual5]

                # Bundling 1
                b1 = item.get('bundling1')
                if b1:
                    update_cols.extend(['hjualo1=%s', 'hjual2o1=%s', 'hjual3o1=%s', 'hjual4o1=%s', 'hjual5o1=%s'])
                    update_vals.extend([float(b1.get('hjual1', 0)), float(b1.get('hjual2', 0)),
                                        float(b1.get('hjual3', 0)), float(b1.get('hjual4', 0)), float(b1.get('hjual5', 0))])

                # Bundling 2
                b2 = item.get('bundling2')
                if b2:
                    update_cols.extend(['hjualo2=%s', 'hjual2o2=%s', 'hjual3o2=%s', 'hjual4o2=%s', 'hjual5o2=%s'])
                    update_vals.extend([float(b2.get('hjual1', 0)), float(b2.get('hjual2', 0)),
                                        float(b2.get('hjual3', 0)), float(b2.get('hjual4', 0)), float(b2.get('hjual5', 0))])

                update_vals.append(artno)
                await cursor.execute(
                    f"UPDATE stock SET {', '.join(update_cols)} WHERE artno=%s",
                    tuple(update_vals)
                )

                # Bundling values for sthist — use new if changed, else keep old
                sthist_o1 = [float(b1.get(f'hjual{n}', 0)) for n in ['1','2','3','4','5']] if b1 else [
                    stock['hjualo1'], stock['hjual2o1'], stock['hjual3o1'], stock['hjual4o1'], stock['hjual5o1']]
                sthist_o2 = [float(b2.get(f'hjual{n}', 0)) for n in ['1','2','3','4','5']] if b2 else [
                    stock['hjualo2'], stock['hjual2o2'], stock['hjual3o2'], stock['hjual4o2'], stock['hjual5o2']]

                # 2. Insert into sthist (tipetrans=0)
                await cursor.execute(
                    """INSERT INTO sthist (
                        stockid, artpabrik, artname, tanggal, whid,
                        hbelibsr, hbelikcl, hbelinetto,
                        pctdisc1, pctdisc2, pctdisc3, pctppn,
                        jlhdisc1, jlhdisc2, jlhdisc3, jlhppn,
                        hjual, hjual2, hjual3, hjual4, hjual5,
                        hjualo1, hjual2o1, hjual3o1, hjual4o1, hjual5o1,
                        hjualo2, hjual2o2, hjual3o2, hjual4o2, hjual5o2,
                        over1, over2, ispaketprc,
                        packing, satuanbsr, satuankcl,
                        nofaktur, tipetrans, becreff,
                        isupdateprice, isupdatepurchprice,
                        oprice, pctprofit, pctprofit2, pctprofit3, pctprofit4, pctprofit5,
                        pricelevel
                    ) VALUES (
                        %s, %s, %s, %s, 'LAPANGAN',
                        %s, %s, %s,
                        %s, %s, %s, %s,
                        %s, %s, %s, %s,
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s,
                        %s, %s, %s,
                        %s, %s, %s,
                        %s, 0, %s,
                        %s, %s,
                        %s, %s, %s, %s, %s, %s,
                        '1'
                    )""",
                    (
                        artno, stock['artpabrik'] or '', stock['artname'] or '', today,
                        stock['hbelibsr'], stock['hbelikcl'], stock['hbelinetto'],
                        stock['pctdisc1'], stock['pctdisc2'], stock['pctdisc3'], stock['pctppn'],
                        stock['jlhdisc1'], stock['jlhdisc2'], stock['jlhdisc3'], stock['jlhppn'],
                        new_hjual, new_hjual2, new_hjual3, new_hjual4, new_hjual5,
                        *sthist_o1,
                        *sthist_o2,
                        stock['over1'], stock['over2'], stock['ispaketprc'],
                        stock['packing'], stock['satbesar'], stock['satkecil'],
                        ph_number, becreff,
                        1 if lock_history else 0,
                        1 if update_purch_price else 0,
                        old_hjual, pctprofit, pctprofit2, pctprofit3, pctprofit4, pctprofit5,
                    )
                )

            # Insert icphg header
            uraian = ', '.join(i.get('artno', '') for i in items[:3])
            if len(items) > 3:
                uraian += f' +{len(items) - 3}'
            # Use first item artname if available for more readable uraian
            first_stock = before_map.get(items[0]['artno'])
            if first_stock:
                uraian = first_stock['artname'] or uraian
                if len(items) > 1:
                    uraian = uraian[:80] + f' +{len(items) - 1}'
            await cursor.execute(
                """INSERT INTO icphg (nobukti, becreff, tglberlaku, uraian, userid)
                   VALUES (%s, %s, %s, %s, %s)""",
                (ph_number, becreff, today, uraian[:200], userid)
            )

            # Increment nextrec.newph
            await cursor.execute("UPDATE nextrec SET newph = newph + 1")
            await conn.commit()

    # Invalidate stock search cache
    try:
        from services.stock_search import invalidate_cache
        invalidate_cache()
    except Exception:
        pass

    logger.info("Price change committed: %s (%d items)", ph_number, len(items))
    return {'ok': True, 'ph_number': ph_number, 'item_count': len(items)}


async def get_price_change_report(pool, report_date: date | None = None) -> list[dict]:
    """Get manual price changes (tipetrans=0) for a specific date from sthist."""
    report_date = report_date or date.today()
    rows = await execute_query(
        pool,
        """SELECT nofaktur, becreff, stockid AS artno, artname, tanggal,
                  hbelibsr, hbelinetto, hjual, hjual2, oprice,
                  pctdisc1, pctdisc2, packing, satuanbsr, posttime
           FROM sthist
           WHERE tipetrans = 0 AND tanggal = %s
           ORDER BY noindex DESC""",
        (report_date,),
    )
    result = []
    for r in rows:
        d = dict(r)
        d['ph_number'] = d.pop('nofaktur')
        d['old_hjual'] = float(d.get('oprice') or 0)
        d['new_hjual'] = float(d.get('hjual') or 0)
        d['tanggal'] = d['tanggal'].isoformat() if d['tanggal'] else ''
        d['posttime'] = d['posttime'].isoformat() if d['posttime'] else ''
        result.append(d)
    return result


async def get_price_change_from_snapshots(pool, report_date: date | None = None) -> list[dict]:
    """Get harga jual changes from PO snapshots (faktur) for a date.
    Returns items where hjual changed, showing old→new hjual1 only."""
    report_date = report_date or date.today()
    rows = await execute_query(
        pool,
        """SELECT po_number, snapshot_json, created_by, created_at
           FROM tokohub.faktur_pembelian_snapshots
           WHERE DATE(created_at) = %s
           ORDER BY id DESC""",
        (report_date,),
    )
    result = []
    for r in rows:
        data = json.loads(r['snapshot_json'])
        for item in data.get('items', []):
            b = item.get('before') or {}
            a = item.get('after') or {}
            old_hjual = float(b.get('hjual') or 0)
            new_hjual = float(a.get('hjual') or 0)
            if old_hjual != new_hjual and new_hjual > 0:
                result.append({
                    'source': 'faktur',
                    'ref_number': r['po_number'],
                    'artno': item['artno'],
                    'artname': a.get('artname') or b.get('artname') or '',
                    'old_hjual': old_hjual,
                    'new_hjual': new_hjual,
                    'created_by': r['created_by'],
                    'created_at': r['created_at'].isoformat() if r['created_at'] else '',
                })
    return result
