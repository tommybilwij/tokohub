"""Price change (Perubahan Harga) service.

Handles reading stock prices, writing price changes to
myposse.sthist (tipetrans=0) and icphg header.
"""

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


async def commit_price_change(pool, items: list[dict], userid: str = '', uraian: str = '') -> dict:
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
                    update_cols.extend(['over1=%s', 'hjualo1=%s', 'hjual2o1=%s', 'hjual3o1=%s', 'hjual4o1=%s', 'hjual5o1=%s'])
                    update_vals.extend([float(b1.get('min_qty', 0)),
                                        float(b1.get('hjual1', 0)), float(b1.get('hjual2', 0)),
                                        float(b1.get('hjual3', 0)), float(b1.get('hjual4', 0)), float(b1.get('hjual5', 0))])

                # Bundling 2
                b2 = item.get('bundling2')
                if b2:
                    update_cols.extend(['over2=%s', 'hjualo2=%s', 'hjual2o2=%s', 'hjual3o2=%s', 'hjual4o2=%s', 'hjual5o2=%s'])
                    update_vals.extend([float(b2.get('min_qty', 0)),
                                        float(b2.get('hjual1', 0)), float(b2.get('hjual2', 0)),
                                        float(b2.get('hjual3', 0)), float(b2.get('hjual4', 0)), float(b2.get('hjual5', 0))])

                # Update ispaketprc flag if any bundling was provided
                if b1 or b2:
                    has_bnd = 1 if ((b1 and float(b1.get('min_qty', 0))) or (b2 and float(b2.get('min_qty', 0)))) else 0
                    update_cols.append('ispaketprc=%s')
                    update_vals.append(has_bnd)

                update_vals.append(artno)
                await cursor.execute(
                    f"UPDATE stock SET {', '.join(update_cols)} WHERE artno=%s",
                    tuple(update_vals)
                )

                # Bundling values for sthist — use new if changed, else keep old from stock
                sthist_o1 = [float(b1.get(f'hjual{n}', 0)) for n in ['1','2','3','4','5']] if b1 else [
                    stock['hjualo1'], stock['hjual2o1'], stock['hjual3o1'], stock['hjual4o1'], stock['hjual5o1']]
                sthist_o2 = [float(b2.get(f'hjual{n}', 0)) for n in ['1','2','3','4','5']] if b2 else [
                    stock['hjualo2'], stock['hjual2o2'], stock['hjual3o2'], stock['hjual4o2'], stock['hjual5o2']]
                sthist_over1 = float(b1.get('min_qty', 0)) if b1 else stock['over1']
                sthist_over2 = float(b2.get('min_qty', 0)) if b2 else stock['over2']
                sthist_ispaketprc = (1 if (sthist_over1 or sthist_over2) else 0) if (b1 or b2) else stock['ispaketprc']

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
                        sthist_over1, sthist_over2, sthist_ispaketprc,
                        stock['packing'], stock['satbesar'], stock['satkecil'],
                        ph_number, becreff,
                        old_hjual, pctprofit, pctprofit2, pctprofit3, pctprofit4, pctprofit5,
                    )
                )

            # Insert icphg header
            if not uraian:
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


async def update_ph(pool, ph_number: str, items: list[dict], userid: str = '', uraian: str = '') -> dict:
    """Update an existing Perubahan Harga.

    Uses in-place UPDATE of sthist rows to preserve original noindex ordering,
    ensuring that newer PH/FP entries correctly take precedence over older ones.

    Phase 1 (atomic): UPDATE/INSERT/DELETE sthist, update icphg header.
    Phase 2 (deferred): apply stock hjual only when no newer transaction has overwritten.
    """
    if not items:
        return {'error': 'No items'}

    header = await execute_single(
        pool,
        "SELECT nobukti, becreff FROM icphg WHERE nobukti = %s",
        (ph_number,),
    )
    if not header:
        return {'error': 'Not found'}

    becreff = header['becreff']

    # Get old sthist lines with noindex + oprice + tanggal for in-place update
    old_lines = await execute_query(
        pool,
        "SELECT stockid, noindex, oprice, tanggal FROM sthist WHERE becreff = %s AND tipetrans = 0",
        (becreff,),
    )
    old_map = {line['stockid']: line for line in old_lines}

    new_artnos = {item['artno'] for item in items}
    all_artnos = list(new_artnos | set(old_map.keys()))
    before_map = await get_stock_prices(pool, all_artnos)
    today = date.today()

    # Phase 1 — Atomic: UPDATE/INSERT/DELETE sthist + update icphg
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cursor:
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

                netto = float(stock['hbelinetto'] or 0)
                def _pct(jual):
                    return round((jual - netto) / netto * 100, 2) if netto > 0 else -100
                pctprofit = _pct(new_hjual)
                pctprofit2 = _pct(new_hjual2) if new_hjual2 else -100
                pctprofit3 = _pct(new_hjual3) if new_hjual3 else -100
                pctprofit4 = _pct(new_hjual4) if new_hjual4 else -100
                pctprofit5 = _pct(new_hjual5) if new_hjual5 else -100

                b1 = item.get('bundling1')
                b2 = item.get('bundling2')
                sthist_o1 = [float(b1.get(f'hjual{n}', 0)) for n in ['1','2','3','4','5']] if b1 else [
                    stock['hjualo1'], stock['hjual2o1'], stock['hjual3o1'], stock['hjual4o1'], stock['hjual5o1']]
                sthist_o2 = [float(b2.get(f'hjual{n}', 0)) for n in ['1','2','3','4','5']] if b2 else [
                    stock['hjualo2'], stock['hjual2o2'], stock['hjual3o2'], stock['hjual4o2'], stock['hjual5o2']]
                sthist_over1 = float(b1.get('min_qty', 0)) if b1 else stock['over1']
                sthist_over2 = float(b2.get('min_qty', 0)) if b2 else stock['over2']
                sthist_ispaketprc = (1 if (sthist_over1 or sthist_over2) else 0) if (b1 or b2) else stock['ispaketprc']

                if artno in old_map:
                    # UPDATE existing sthist row by noindex (preserves chronological ordering)
                    oprice = float(old_map[artno].get('oprice') or 0)
                    await cursor.execute(
                        """UPDATE sthist SET
                            artpabrik=%s, artname=%s, tanggal=%s,
                            hbelibsr=%s, hbelikcl=%s, hbelinetto=%s,
                            pctdisc1=%s, pctdisc2=%s, pctdisc3=%s, pctppn=%s,
                            jlhdisc1=%s, jlhdisc2=%s, jlhdisc3=%s, jlhppn=%s,
                            hjual=%s, hjual2=%s, hjual3=%s, hjual4=%s, hjual5=%s,
                            hjualo1=%s, hjual2o1=%s, hjual3o1=%s, hjual4o1=%s, hjual5o1=%s,
                            hjualo2=%s, hjual2o2=%s, hjual3o2=%s, hjual4o2=%s, hjual5o2=%s,
                            over1=%s, over2=%s, ispaketprc=%s,
                            packing=%s, satuanbsr=%s, satuankcl=%s,
                            oprice=%s, pctprofit=%s, pctprofit2=%s, pctprofit3=%s,
                            pctprofit4=%s, pctprofit5=%s,
                            posttime=NOW()
                        WHERE noindex=%s""",
                        (
                            stock['artpabrik'] or '', stock['artname'] or '', today,
                            stock['hbelibsr'], stock['hbelikcl'], stock['hbelinetto'],
                            stock['pctdisc1'], stock['pctdisc2'], stock['pctdisc3'], stock['pctppn'],
                            stock['jlhdisc1'], stock['jlhdisc2'], stock['jlhdisc3'], stock['jlhppn'],
                            new_hjual, new_hjual2, new_hjual3, new_hjual4, new_hjual5,
                            *sthist_o1,
                            *sthist_o2,
                            sthist_over1, sthist_over2, sthist_ispaketprc,
                            stock['packing'], stock['satbesar'], stock['satkecil'],
                            oprice, pctprofit, pctprofit2, pctprofit3,
                            pctprofit4, pctprofit5,
                            old_map[artno]['noindex'],
                        ),
                    )
                else:
                    # INSERT new sthist row (gets new auto-increment noindex)
                    old_hjual = float(stock['hjual'] or 0)
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
                            sthist_over1, sthist_over2, sthist_ispaketprc,
                            stock['packing'], stock['satbesar'], stock['satkecil'],
                            ph_number, becreff,
                            old_hjual, pctprofit, pctprofit2, pctprofit3, pctprofit4, pctprofit5,
                        ),
                    )

            # Delete removed items from sthist
            for artno, old in old_map.items():
                if artno not in new_artnos:
                    await cursor.execute(
                        "DELETE FROM sthist WHERE noindex = %s",
                        (old['noindex'],),
                    )

            # Update icphg header
            if not uraian:
                uraian = ', '.join(i.get('artno', '') for i in items[:3])
                if len(items) > 3:
                    uraian += f' +{len(items) - 3}'
                first_stock = before_map.get(items[0]['artno'])
                if first_stock:
                    uraian = first_stock['artname'] or uraian
                    if len(items) > 1:
                        uraian = uraian[:80] + f' +{len(items) - 1}'
            await cursor.execute(
                "UPDATE icphg SET uraian = %s, userid = %s WHERE nobukti = %s",
                (uraian[:200], userid, ph_number),
            )
            await conn.commit()

    # Phase 2 — Deferred stock updates with tanggal-based precedence checks.
    updated_lines = await execute_query(
        pool,
        "SELECT stockid, noindex, tanggal FROM sthist WHERE becreff = %s AND tipetrans = 0",
        (becreff,),
    )
    noindex_map = {r['stockid']: r['noindex'] for r in updated_lines}
    tanggal_map = {r['stockid']: r['tanggal'] for r in updated_lines}

    from services.stock_restore import (
        has_newer_hjual_update, get_previous_hjual, get_init_hjual,
        RESTORE_HJUAL_SQL, hjual_params,
    )

    for item in items:
        artno = item['artno']
        ni = noindex_map.get(artno)
        tgl = tanggal_map.get(artno)
        stock = before_map.get(artno)
        if not ni or not tgl or not stock:
            continue

        if await has_newer_hjual_update(pool, artno, tgl, ni):
            continue  # Newer PH/FP has already overwritten stock hjual

        try:
            new_hjual = float(item.get('hjual', stock['hjual']))
            new_hjual2 = float(item.get('hjual2', stock['hjual2']))
            new_hjual3 = float(item.get('hjual3', stock['hjual3']))
            new_hjual4 = float(item.get('hjual4', stock['hjual4']))
            new_hjual5 = float(item.get('hjual5', stock['hjual5']))

            update_cols = ['hjual=%s', 'hjual2=%s', 'hjual3=%s', 'hjual4=%s', 'hjual5=%s']
            update_vals = [new_hjual, new_hjual2, new_hjual3, new_hjual4, new_hjual5]

            b1 = item.get('bundling1')
            if b1:
                update_cols.extend(['over1=%s', 'hjualo1=%s', 'hjual2o1=%s', 'hjual3o1=%s', 'hjual4o1=%s', 'hjual5o1=%s'])
                update_vals.extend([float(b1.get('min_qty', 0)),
                                    float(b1.get('hjual1', 0)), float(b1.get('hjual2', 0)),
                                    float(b1.get('hjual3', 0)), float(b1.get('hjual4', 0)), float(b1.get('hjual5', 0))])
            b2 = item.get('bundling2')
            if b2:
                update_cols.extend(['over2=%s', 'hjualo2=%s', 'hjual2o2=%s', 'hjual3o2=%s', 'hjual4o2=%s', 'hjual5o2=%s'])
                update_vals.extend([float(b2.get('min_qty', 0)),
                                    float(b2.get('hjual1', 0)), float(b2.get('hjual2', 0)),
                                    float(b2.get('hjual3', 0)), float(b2.get('hjual4', 0)), float(b2.get('hjual5', 0))])
            if b1 or b2:
                has_bnd = 1 if ((b1 and float(b1.get('min_qty', 0))) or (b2 and float(b2.get('min_qty', 0)))) else 0
                update_cols.append('ispaketprc=%s')
                update_vals.append(has_bnd)

            update_vals.append(artno)
            await execute_modify(
                pool,
                f"UPDATE stock SET {', '.join(update_cols)} WHERE artno=%s",
                tuple(update_vals),
            )
        except Exception:
            logger.warning("Deferred stock update failed for %s", artno, exc_info=True)

    # Restore stock for removed items
    for artno, old in old_map.items():
        if artno in new_artnos:
            continue
        old_ni = old['noindex']
        old_tgl = old.get('tanggal') or today
        if await has_newer_hjual_update(pool, artno, old_tgl, old_ni):
            continue
        prev = await get_previous_hjual(pool, artno, old_tgl, old_ni)
        if not prev:
            prev = await get_init_hjual(pool, artno)
        if prev:
            try:
                await execute_modify(pool, RESTORE_HJUAL_SQL, hjual_params(prev, artno))
            except Exception:
                logger.warning("Failed to restore hjual for %s", artno, exc_info=True)

    try:
        from services.stock_search import invalidate_cache
        invalidate_cache()
    except Exception:
        pass

    logger.info("Price change updated: %s (%d items)", ph_number, len(items))
    return {'ok': True, 'ph_number': ph_number, 'item_count': len(items)}


async def delete_ph(pool, ph_number: str) -> dict:
    """Delete a Perubahan Harga: restore old hjual+bundling from sthist history, hard-delete rows."""
    header = await execute_single(
        pool,
        "SELECT nobukti, becreff, islocked FROM icphg WHERE nobukti = %s",
        (ph_number,),
    )
    if not header:
        return {'error': 'Not found'}
    if header['islocked']:
        return {'error': 'Perubahan harga terkunci, tidak bisa dihapus'}

    becreff = header['becreff']

    # Get sthist lines for price restoration (include tanggal for precedence checks)
    lines = await execute_query(
        pool,
        "SELECT stockid, noindex, tanggal FROM sthist WHERE becreff = %s AND tipetrans = 0",
        (becreff,),
    )

    # Build per-item noindex range + tanggal
    item_noindex = {}
    for line in lines:
        artno = line['stockid']
        ni = line['noindex']
        tgl = line['tanggal']
        if artno not in item_noindex:
            item_noindex[artno] = {'min': ni, 'max': ni, 'tanggal': tgl}
        else:
            item_noindex[artno]['min'] = min(item_noindex[artno]['min'], ni)
            item_noindex[artno]['max'] = max(item_noindex[artno]['max'], ni)

    # Phase 1 — Atomic: delete sthist + icphg
    async with pool.acquire() as conn:
        async with conn.cursor() as cursor:
            try:
                await cursor.execute(
                    "DELETE FROM sthist WHERE becreff = %s AND tipetrans = 0", (becreff,),
                )
                await cursor.execute(
                    "DELETE FROM icphg WHERE nobukti = %s", (ph_number,),
                )
                await conn.commit()
            except Exception:
                await conn.rollback()
                logger.exception("Price change delete failed")
                raise

    # Phase 2 — Restore hjual + bundling from previous sthist entries
    from services.stock_restore import (
        get_previous_hjual, has_newer_hjual_update, get_init_hjual,
        RESTORE_HJUAL_SQL, hjual_params,
    )

    for artno, ni in item_noindex.items():
        tgl = ni['tanggal']
        if await has_newer_hjual_update(pool, artno, tgl, ni['max']):
            continue
        prev = await get_previous_hjual(pool, artno, tgl, ni['min'])
        if not prev:
            prev = await get_init_hjual(pool, artno)
        if prev:
            try:
                await execute_modify(pool, RESTORE_HJUAL_SQL, hjual_params(prev, artno))
            except Exception:
                logger.warning("Failed to restore hjual for %s", artno, exc_info=True)

    try:
        from services.stock_search import invalidate_cache
        invalidate_cache()
    except Exception:
        pass

    logger.info("Price change deleted: %s (becreff=%d, lines=%d)", ph_number, becreff, len(lines))
    return {'ok': True, 'ph_number': ph_number, 'lines_deleted': len(lines)}


async def get_ph_history(pool, page=1, per_page=20, date_from=None, date_to=None) -> tuple:
    """Get paginated list of price change headers from icphg."""
    where = []
    params = []
    if date_from:
        where.append("h.tglberlaku >= %s")
        params.append(date_from)
    if date_to:
        where.append("h.tglberlaku <= %s")
        params.append(date_to)
    where_sql = (' AND ' + ' AND '.join(where)) if where else ''

    count_row = await execute_single(
        pool,
        f"SELECT COUNT(*) as cnt FROM icphg h WHERE 1=1{where_sql}",
        tuple(params),
    )
    total = count_row['cnt'] if count_row else 0

    offset = (page - 1) * per_page
    rows = await execute_query(
        pool,
        f"""SELECT h.nobukti, h.tglberlaku, h.uraian, h.userid, h.islocked, h.becreff,
                   (SELECT COUNT(*) FROM sthist s WHERE s.becreff = h.becreff AND s.tipetrans = 0) as line_count
            FROM icphg h
            WHERE 1=1{where_sql}
            ORDER BY h.becreff DESC
            LIMIT %s OFFSET %s""",
        tuple(params) + (per_page, offset),
    )
    return rows, total


async def get_ph_detail(pool, ph_number: str) -> dict | None:
    """Get price change header + line items from sthist."""
    header = await execute_single(
        pool,
        "SELECT nobukti, becreff, tglberlaku, uraian, userid, islocked FROM icphg WHERE nobukti = %s",
        (ph_number,),
    )
    if not header:
        return None

    lines = await execute_query(
        pool,
        """SELECT stockid, artpabrik, artname, oprice, hjual, hjual2, hjual3, hjual4, hjual5,
                  hbelibsr, hbelikcl, hbelinetto, packing, satuanbsr, satuankcl,
                  pctdisc1, pctdisc2, pctdisc3, pctppn,
                  over1, over2, ispaketprc,
                  hjualo1, hjual2o1, hjual3o1, hjual4o1, hjual5o1,
                  hjualo2, hjual2o2, hjual3o2, hjual4o2, hjual5o2
           FROM sthist WHERE becreff = %s AND tipetrans = 0 ORDER BY noindex""",
        (header['becreff'],),
    )
    result = dict(header)
    result['tglberlaku'] = result['tglberlaku'].isoformat() if result['tglberlaku'] else ''
    result['lines'] = []
    _float_keys = (
        'oprice', 'hjual', 'hjual2', 'hjual3', 'hjual4', 'hjual5',
        'hbelibsr', 'hbelikcl', 'hbelinetto', 'packing',
        'pctdisc1', 'pctdisc2', 'pctdisc3', 'pctppn',
        'over1', 'over2',
        'hjualo1', 'hjual2o1', 'hjual3o1', 'hjual4o1', 'hjual5o1',
        'hjualo2', 'hjual2o2', 'hjual3o2', 'hjual4o2', 'hjual5o2',
    )
    for l in lines:
        d = dict(l)
        for k in _float_keys:
            d[k] = float(d.get(k) or 0)
        result['lines'].append(d)
    return result


async def toggle_ph_lock(pool, ph_number: str) -> dict:
    """Toggle islocked on icphg."""
    header = await execute_single(
        pool, "SELECT nobukti, becreff, islocked FROM icphg WHERE nobukti = %s", (ph_number,),
    )
    if not header:
        return {'error': 'Not found'}
    new_val = 0 if header['islocked'] else 1
    await execute_modify(pool, "UPDATE icphg SET islocked = %s WHERE nobukti = %s", (new_val, ph_number))
    return {'ok': True, 'islocked': new_val}


async def get_price_change_report(pool, report_date: date | None = None) -> list[dict]:
    """Get manual price changes (tipetrans=0) for a specific date from sthist."""
    report_date = report_date or date.today()
    rows = await execute_query(
        pool,
        """SELECT s.nofaktur, s.becreff, s.stockid AS artno, s.artpabrik, s.artname, s.tanggal,
                  s.hbelibsr, s.hbelinetto, s.hjual, s.hjual2, s.oprice,
                  s.pctdisc1, s.pctdisc2, s.packing, s.satuanbsr, s.posttime,
                  st.deptid
           FROM sthist s
           LEFT JOIN stock st ON st.artno = s.stockid
           WHERE s.tipetrans = 0 AND s.tanggal = %s
           ORDER BY s.noindex DESC""",
        (report_date,),
    )
    result = []
    for r in rows:
        d = dict(r)
        d['ph_number'] = d.pop('nofaktur')
        d['barcode'] = d.get('artpabrik') or ''
        d['department'] = d.get('deptid') or ''
        d['old_hjual'] = float(d.get('oprice') or 0)
        d['new_hjual'] = float(d.get('hjual') or 0)
        d['tanggal'] = d['tanggal'].isoformat() if d['tanggal'] else ''
        d['posttime'] = d['posttime'].isoformat() if d['posttime'] else ''
        result.append(d)
    return result


async def get_price_change_from_fp(pool, report_date: date | None = None) -> list[dict]:
    """Get harga jual changes from FP sthist (tipetrans=1, isupdateprice=1) for a date.
    Returns items where hjual changed compared to previous sthist entry."""
    report_date = report_date or date.today()
    rows = await execute_query(
        pool,
        """SELECT s.nofaktur, s.stockid AS artno, s.artpabrik, s.artname, s.noindex,
                  s.tanggal, s.hjual, s.posttime, b.userid
           FROM sthist s
           LEFT JOIN icbym b ON b.nofaktur = s.nofaktur AND b.tipe = '1'
           WHERE s.tipetrans = 1 AND s.isupdateprice = 1 AND s.tanggal = %s
           ORDER BY s.noindex DESC""",
        (report_date,),
    )
    all_items = []
    for r in rows:
        artno = r['artno']
        new_hjual = float(r['hjual'] or 0)
        tgl = r['tanggal']
        ni = r['noindex']
        # Find previous hjual from sthist (tanggal-based ordering)
        prev = await execute_single(
            pool,
            """SELECT hjual FROM sthist
               WHERE stockid = %s
                 AND (tanggal < %s OR (tanggal = %s AND noindex < %s))
                 AND (tipetrans = 0 OR (tipetrans = 1 AND isupdateprice = 1))
               ORDER BY tanggal DESC, noindex DESC LIMIT 1""",
            (artno, tgl, tgl, ni),
        )
        old_hjual = float(prev['hjual'] or 0) if prev else 0
        if old_hjual != new_hjual and new_hjual > 0:
            all_items.append({
                'source': 'faktur',
                'ref_number': r['nofaktur'],
                'artno': artno,
                'artname': r['artname'] or '',
                'old_hjual': old_hjual,
                'new_hjual': new_hjual,
                'created_by': r['userid'] or '',
                'created_at': r['posttime'].isoformat() if r['posttime'] else '',
            })
    # Look up barcode & department from stock
    artnos = list({it['artno'] for it in all_items})
    stock_map = {}
    if artnos:
        ph = ','.join(['%s'] * len(artnos))
        stock_rows = await execute_query(
            pool,
            f"SELECT artno, artpabrik, deptid FROM stock WHERE artno IN ({ph})",
            tuple(artnos),
        )
        for sr in stock_rows:
            stock_map[sr['artno']] = sr
    for it in all_items:
        si = stock_map.get(it['artno']) or {}
        it['barcode'] = si.get('artpabrik') or ''
        it['department'] = si.get('deptid') or ''
    return all_items
