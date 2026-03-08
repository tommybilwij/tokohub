"""Faktur Pembelian creation and stock balance update (async).

No table locking — all writes use atomic single-row operations
(UPDATE ... SET col = col + X) so MyPosse POS and this app can
read and write concurrently without blocking each other.

Only writes to icbym (header) + sthist (line items/history).
Does NOT write to icpom/icpos (those are pesanan tables, unused here).
"""

import json
import os
import logging
import warnings
from datetime import date, datetime
from decimal import Decimal, ROUND_DOWN

import aiomysql

warnings.filterwarnings('ignore', message='Data truncated', module='aiomysql')

from config import settings
from services.db import execute_query, execute_single, execute_modify

logger = logging.getLogger(__name__)


class POCreationError(Exception):
    """Raised when faktur pembelian creation fails."""


def _bundling_flag(line: dict) -> int:
    """Return ispaketprc flag from preview line bundling data."""
    b1 = line.get('bundling1') or {}
    b2 = line.get('bundling2') or {}
    return 1 if (b1.get('min_qty') or b2.get('min_qty')) else 0


def _bundling_val(line: dict, key: str, field: str) -> float:
    """Extract a bundling field value from preview line, default 0."""
    b = line.get(key) or {}
    return float(b.get(field) or 0)


async def _generate_fp_number(cursor, order_date):
    """Generate Faktur Pembelian number: FP{YYMMDD}{5-digit-seq}."""
    prefix = f"FP{order_date.strftime('%y%m%d')}"
    await cursor.execute(
        "SELECT nofaktur FROM icbym WHERE nofaktur LIKE %s ORDER BY nofaktur DESC LIMIT 1",
        (f"{prefix}%",)
    )
    row = await cursor.fetchone()
    if row:
        last_seq = int(row['nofaktur'][-5:])
        seq = last_seq + 1
    else:
        seq = 1
    return f"{prefix}{seq:05d}"


def _decimal_default(obj):
    """JSON serializer for Decimal types."""
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def _write_audit_log(fp_number, fp_data):
    """Write faktur data as JSON to audit log."""
    os.makedirs(str(settings.log_folder), exist_ok=True)
    log_file = os.path.join(str(settings.log_folder), f"{fp_number}.json")
    with open(log_file, 'w') as f:
        json.dump(fp_data, f, indent=2, default=_decimal_default)
    logger.info("Audit log written: %s", log_file)


async def get_stock_details(pool, artno_list):
    """Load full stock details for a list of artnos."""
    if not artno_list:
        return {}
    placeholders = ','.join(['%s'] * len(artno_list))
    rows = await execute_query(
        pool,
        f"""SELECT artno, artpabrik, artname, suppid, deptid,
                   satbesar, satkecil, packing,
                   hbelibsr, hbelikcl, pctdisc1, pctdisc2, pctdisc3,
                   pctppn, hjual, hjual2, hjual3, hjual4, hjual5
            FROM stock
            WHERE artno IN ({placeholders})""",
        tuple(artno_list)
    )
    return {row['artno']: row for row in rows}


async def preview_fp(pool, supplier_id, items, order_date=None, shipping_cost=0):
    """Build a FP preview without committing.

    Args:
        pool: aiomysql connection pool
        supplier_id: Vendor ID
        items: List of {artno, qty, price_override (optional)}
        order_date: Date for FP (defaults to today)
        shipping_cost: Shipping cost to distribute proportionally into tax (jlhppn)

    Returns:
        dict with header info and line items with calculated pricing
    """
    order_date = order_date or date.today()
    artno_list = [item['artno'] for item in items]
    stock_map = await get_stock_details(pool, artno_list)

    # Per-item shipping: sum item-level shipping_cost; fall back to header-level total
    has_per_item_shipping = any(item.get('shipping_cost') for item in items)
    header_shipping = Decimal(str(shipping_cost or 0))

    lines = []
    grand_total = Decimal('0')

    for item in items:
        artno = item['artno']
        stock = stock_map.get(artno)
        if not stock:
            raise POCreationError(f"Stock item not found: {artno}")

        qty = Decimal(str(item['qty']))
        packing_ovr = item.get('packing_override')
        if packing_ovr and Decimal(str(packing_ovr)) > 0:
            packing = Decimal(str(packing_ovr))
        else:
            packing = stock['packing'] or Decimal('1')

        # Use override price if provided, else stock's hbelibsr
        if item.get('price_override') and Decimal(str(item['price_override'])) > 0:
            hbelibsr = Decimal(str(item['price_override']))
        else:
            hbelibsr = stock['hbelibsr'] or Decimal('0')

        # Calculate small-unit price
        hbelikcl = (hbelibsr / packing).quantize(Decimal('0.01'), rounding=ROUND_DOWN) if packing else hbelibsr

        # Discounts (use override if provided, else 0 — empty means no discount)
        pctdisc1 = Decimal(str(item['disc1_override'])) if item.get('disc1_override') is not None else Decimal('0')
        pctdisc2 = Decimal(str(item['disc2_override'])) if item.get('disc2_override') is not None else Decimal('0')
        pctdisc3 = Decimal(str(item['disc3_override'])) if item.get('disc3_override') is not None else Decimal('0')

        disc1 = hbelibsr * pctdisc1 / 100
        after_disc1 = hbelibsr - disc1
        disc2 = after_disc1 * pctdisc2 / 100
        after_disc2 = after_disc1 - disc2

        # Per-small-unit discount amounts (for stock table)
        disc1_kcl = hbelikcl * pctdisc1 / 100
        after_disc1_kcl = hbelikcl - disc1_kcl
        disc2_kcl = after_disc1_kcl * pctdisc2 / 100
        after_disc2_kcl = after_disc1_kcl - disc2_kcl

        # Tax applied before D3 (use override if provided, else 0)
        pctppn = Decimal(str(item['ppn_override'])) if item.get('ppn_override') is not None else Decimal('0')
        ppn = after_disc2 * pctppn / 100
        ppn_kcl = after_disc2_kcl * pctppn / 100

        # D3 applied after PPN
        after_ppn = after_disc2 + ppn
        after_ppn_kcl = after_disc2_kcl + ppn_kcl
        disc3 = after_ppn * pctdisc3 / 100
        disc3_kcl = after_ppn_kcl * pctdisc3 / 100
        hbelinetto = after_ppn - disc3
        hbelinetto_kcl = after_ppn_kcl - disc3_kcl

        amount = hbelinetto * qty
        netto_full = hbelinetto  # per-unit netto (before shipping)

        # Per-item shipping
        item_shipping = Decimal(str(item.get('shipping_cost') or 0)) if has_per_item_shipping else Decimal('0')
        amount_with_ship = amount + item_shipping
        netto_full_with_ship = netto_full + (item_shipping / qty if qty else Decimal('0'))
        jlhppn_with_ship = float(ppn * qty) + float(item_shipping)

        lines.append({
            'artno': artno,
            'artpabrik': stock['artpabrik'] or '',
            'artname': stock['artname'] or '',
            'qty': float(qty),
            'qty_besar': int(item.get('qty_besar', qty)),
            'packing': float(packing),
            'satuanbsr': item.get('satuan_bsr') or stock['satbesar'] or '',
            'satuankcl': stock['satkecil'] or '',
            'hbelibsr': float(hbelibsr),
            'hbelikcl': float(hbelikcl),
            'hbelinetto': float(hbelinetto),
            'netto_full': float(netto_full_with_ship),
            'jlhdisc1': float(disc1 * qty),
            'jlhdisc2': float(disc2 * qty),
            'jlhdisc3': float(disc3 * qty),
            'pctdisc1': float(pctdisc1),
            'pctdisc2': float(pctdisc2),
            'pctdisc3': float(pctdisc3),
            'pctppn': float(pctppn),
            'jlhppn': jlhppn_with_ship,
            'jlhdisc1_kcl': float(disc1_kcl),
            'jlhdisc2_kcl': float(disc2_kcl),
            'jlhdisc3_kcl': float(disc3_kcl),
            'hbelinetto_kcl': float(hbelinetto_kcl),
            'jlhppn_kcl': float(ppn_kcl),
            'hjual': float(item['hjual1_override']) if item.get('hjual1_override') is not None else float(stock['hjual'] or 0),
            'hjual2': float(item['hjual2_override']) if item.get('hjual2_override') is not None else float(stock['hjual2'] or 0),
            'hjual3': float(item['hjual3_override']) if item.get('hjual3_override') is not None else float(stock['hjual3'] or 0),
            'hjual4': float(item['hjual4_override']) if item.get('hjual4_override') is not None else float(stock['hjual4'] or 0),
            'hjual5': float(item['hjual5_override']) if item.get('hjual5_override') is not None else float(stock['hjual5'] or 0),
            'foc': int(item.get('foc', 0)),
            'shipping_cost': float(item_shipping),
            'amount': float(amount_with_ship),
            'bundling1': item.get('bundling1'),
            'bundling2': item.get('bundling2'),
        })
        grand_total += amount_with_ship

    # Legacy fallback: distribute header-level shipping if no per-item shipping was provided
    if not has_per_item_shipping and header_shipping > 0 and grand_total > 0:
        num_lines = len(lines)
        shipping_per_item = float(header_shipping / num_lines)
        for line in lines:
            weight = Decimal(str(line['amount'])) / grand_total
            line_shipping = float(header_shipping * weight)
            line['jlhppn'] = line['jlhppn'] + line_shipping
            line['amount'] = line['amount'] + line_shipping
            line['netto_full'] = line['netto_full'] + shipping_per_item
        grand_total += header_shipping

    return {
        'supplier_id': supplier_id,
        'order_date': order_date.isoformat(),
        'lines': lines,
        'grand_total': float(grand_total),
        'line_count': len(lines),
        'shipping_cost': float(sum(Decimal(str(item.get('shipping_cost') or 0)) for item in items) or header_shipping),
    }


async def commit_fp(pool, supplier_id, items, order_date=None, userid=None, shipping_cost=0, update_price=True, due_date=None, uraian=None):
    """Create Faktur Pembelian in two phases to minimise lock contention with MyPosse POS.

    Phase 1 (single transaction):
        INSERT icbym header + sthist lines, UPDATE stlastbal + nextrec, COMMIT.

    Phase 2 (individual auto-committed updates):
        UPDATE stock prices and bundling columns per item.
        Each is a separate ~1ms transaction so MyPosse is never blocked.

    Returns:
        dict with FP number and summary
    """
    if not userid:
        raise POCreationError("userid is required")
    order_date = order_date or date.today()
    preview = await preview_fp(pool, supplier_id, items, order_date, shipping_cost=shipping_cost)

    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cursor:
            try:
                # Lock nextrec row to serialise concurrent creation.
                await cursor.execute("SELECT newpurch FROM nextrec LIMIT 1 FOR UPDATE")
                nextrec = await cursor.fetchone()
                if not nextrec:
                    raise POCreationError("nextrec table is empty")
                fp_becreff = nextrec['newpurch']

                # Generate FP number
                fp_number = await _generate_fp_number(cursor, order_date)

                # Insert Faktur Pembelian header (icbym)
                _due = due_date or order_date
                await cursor.execute(
                    """INSERT INTO icbym
                       (nofaktur, tipe, becreff, suppid, tglfaktur, duedate,
                        jlhfaktur, lokasi, userid, uraian,
                        isupdateprice, islocked)
                       VALUES (%s, '1', %s, %s, %s, %s,
                               %s, 'LAPANGAN', %s, %s,
                               %s, 0)""",
                    (fp_number, fp_becreff, supplier_id, order_date, _due,
                     preview['grand_total'], userid, uraian, 1 if update_price else 0)
                )

                # Insert line items into sthist
                iup = 1 if update_price else 0
                for line in preview['lines']:
                    foc = Decimal(str(line.get('foc', 0)))
                    qty_small = Decimal(str(line['qty'])) * Decimal(str(line['packing'])) + foc

                    await cursor.execute(
                        """INSERT INTO sthist
                           (stockid, artpabrik, artname, tanggal,
                            qty, beli, packing, satuanbsr, satuankcl,
                            hbelibsr, hbelikcl, hbelinetto,
                            pctdisc1, pctdisc2, pctdisc3,
                            jlhdisc1, jlhdisc2, jlhdisc3,
                            pctppn, jlhppn,
                            hjual, hjual2, hjual3, hjual4, hjual5,
                            ispaketprc, over1, over2,
                            hjualo1, hjual2o1, hjual3o1, hjual4o1, hjual5o1,
                            hjualo2, hjual2o2, hjual3o2, hjual4o2, hjual5o2,
                            amount, qtybonus,
                            suppid, whid, nofaktur, becreff, tipetrans,
                            isupdateprice, isupdatepurchprice)
                           VALUES (%s, %s, %s, %s,
                                   %s, %s, %s, %s, %s,
                                   %s, %s, %s,
                                   %s, %s, %s,
                                   %s, %s, %s,
                                   %s, %s,
                                   %s, %s, %s, %s, %s,
                                   %s, %s, %s,
                                   %s, %s, %s, %s, %s,
                                   %s, %s, %s, %s, %s,
                                   %s, %s,
                                   %s, 'LAPANGAN', %s, %s, 1,
                                   %s, %s)""",
                        (line['artno'], line['artpabrik'], line['artname'], order_date,
                         line['qty'], float(qty_small), line['packing'],
                         line['satuanbsr'], line['satuankcl'],
                         line['hbelibsr'], line['hbelikcl'], line['hbelinetto'],
                         line['pctdisc1'], line['pctdisc2'], line['pctdisc3'],
                         line['jlhdisc1'], line['jlhdisc2'], line['jlhdisc3'],
                         line['pctppn'], line['jlhppn'],
                         line['hjual'], line['hjual2'], line['hjual3'],
                         line['hjual4'], line['hjual5'],
                         _bundling_flag(line),
                         _bundling_val(line, 'bundling1', 'min_qty'),
                         _bundling_val(line, 'bundling2', 'min_qty'),
                         _bundling_val(line, 'bundling1', 'hjual1'),
                         _bundling_val(line, 'bundling1', 'hjual2'),
                         _bundling_val(line, 'bundling1', 'hjual3'),
                         _bundling_val(line, 'bundling1', 'hjual4'),
                         _bundling_val(line, 'bundling1', 'hjual5'),
                         _bundling_val(line, 'bundling2', 'hjual1'),
                         _bundling_val(line, 'bundling2', 'hjual2'),
                         _bundling_val(line, 'bundling2', 'hjual3'),
                         _bundling_val(line, 'bundling2', 'hjual4'),
                         _bundling_val(line, 'bundling2', 'hjual5'),
                         line['amount'], line.get('foc', 0),
                         supplier_id, fp_number, fp_becreff,
                         iup, iup)
                    )

                # Batch stock balance updates
                for line in preview['lines']:
                    foc = Decimal(str(line.get('foc', 0)))
                    qty_small = Decimal(str(line['qty'])) * Decimal(str(line['packing'])) + foc
                    await cursor.execute(
                        """UPDATE stlastbal
                           SET curqty = curqty + %s
                           WHERE artno = %s AND warehouseid = 'LAPANGAN'""",
                        (float(qty_small), line['artno'])
                    )
                    if cursor.rowcount == 0:
                        await cursor.execute(
                            """INSERT INTO stlastbal (artno, curqty, warehouseid)
                               VALUES (%s, %s, 'LAPANGAN')""",
                            (line['artno'], float(qty_small))
                        )

                # Increment nextrec counter
                await cursor.execute(
                    "UPDATE nextrec SET newpurch = newpurch + 1"
                )

                await conn.commit()

            except Exception:
                await conn.rollback()
                logger.exception("Faktur Pembelian creation failed (Phase 1)")
                raise

    # ------------------------------------------------------------------
    # Phase 2 — Deferred stock updates.
    # Harga beli, discounts, tax, satuan, packing: ALWAYS updated.
    # Harga jual + bundling: only when update_price=True.
    # ------------------------------------------------------------------
    for line in preview['lines']:
        # Always update harga beli
        try:
            if update_price:
                await execute_modify(
                    pool,
                    """UPDATE stock
                       SET hbelibsr = %s, hbelikcl = %s, hbelinetto = %s,
                           pctdisc1 = %s, pctdisc2 = %s, pctdisc3 = %s,
                           jlhdisc1 = %s, jlhdisc2 = %s, jlhdisc3 = %s,
                           pctppn = %s, jlhppn = %s,
                           hjual = %s, hjual2 = %s, hjual3 = %s,
                           hjual4 = %s, hjual5 = %s,
                           satbesar = %s, packing = %s
                       WHERE artno = %s""",
                    (line['hbelibsr'], line['hbelikcl'], line['hbelinetto_kcl'],
                     line['pctdisc1'], line['pctdisc2'], line['pctdisc3'],
                     line['jlhdisc1_kcl'], line['jlhdisc2_kcl'], line['jlhdisc3_kcl'],
                     line['pctppn'], line['jlhppn_kcl'],
                     line['hjual'], line['hjual2'], line['hjual3'],
                     line['hjual4'], line['hjual5'],
                     line['satuanbsr'], line['packing'],
                     line['artno']),
                )
            else:
                await execute_modify(
                    pool,
                    """UPDATE stock
                       SET hbelibsr = %s, hbelikcl = %s, hbelinetto = %s,
                           pctdisc1 = %s, pctdisc2 = %s, pctdisc3 = %s,
                           jlhdisc1 = %s, jlhdisc2 = %s, jlhdisc3 = %s,
                           pctppn = %s, jlhppn = %s,
                           satbesar = %s, packing = %s
                       WHERE artno = %s""",
                    (line['hbelibsr'], line['hbelikcl'], line['hbelinetto_kcl'],
                     line['pctdisc1'], line['pctdisc2'], line['pctdisc3'],
                     line['jlhdisc1_kcl'], line['jlhdisc2_kcl'], line['jlhdisc3_kcl'],
                     line['pctppn'], line['jlhppn_kcl'],
                     line['satuanbsr'], line['packing'],
                     line['artno']),
                )
        except Exception:
            logger.warning("Deferred stock price update failed for %s", line['artno'], exc_info=True)

        # Harga jual bundling: only when update_price=True
        if update_price:
            b1 = line.get('bundling1') or {}
            b2 = line.get('bundling2') or {}
            has_bundling = 1 if (b1.get('min_qty') or b2.get('min_qty')) else 0
            try:
                await execute_modify(
                    pool,
                    """UPDATE stock
                       SET ispaketprc = %s,
                           over1 = %s,
                           hjualo1 = %s, hjual2o1 = %s, hjual3o1 = %s, hjual4o1 = %s, hjual5o1 = %s,
                           over2 = %s,
                           hjualo2 = %s, hjual2o2 = %s, hjual3o2 = %s, hjual4o2 = %s, hjual5o2 = %s
                       WHERE artno = %s""",
                    (has_bundling,
                     b1.get('min_qty') or 0,
                     b1.get('hjual1') or 0, b1.get('hjual2') or 0, b1.get('hjual3') or 0,
                     b1.get('hjual4') or 0, b1.get('hjual5') or 0,
                     b2.get('min_qty') or 0,
                     b2.get('hjual1') or 0, b2.get('hjual2') or 0, b2.get('hjual3') or 0,
                     b2.get('hjual4') or 0, b2.get('hjual5') or 0,
                     line['artno']),
                )
            except Exception:
                logger.warning("Deferred bundling update failed for %s", line['artno'], exc_info=True)

    from services.stock_search import invalidate_cache
    invalidate_cache()

    result = {
        'fp_number': fp_number,
        'fp_becreff': fp_becreff,
        'supplier_id': supplier_id,
        'order_date': order_date.isoformat(),
        'grand_total': preview['grand_total'],
        'line_count': preview['line_count'],
        'lines': preview['lines'],
    }

    _write_audit_log(fp_number, result)

    logger.info("Faktur Pembelian created: %s (becreff=%d, total=%.2f)",
                fp_number, fp_becreff, preview['grand_total'])
    return result


async def delete_fp(pool, fp_number: str) -> dict:
    """Delete a Faktur Pembelian: reverse stock balance, restore prices from sthist history, hard-delete rows."""
    header = await execute_single(
        pool,
        "SELECT nofaktur, becreff, islocked, isupdateprice FROM icbym WHERE nofaktur = %s AND tipe = '1'",
        (fp_number,),
    )
    if not header:
        return {'error': 'Faktur not found'}
    if header['islocked']:
        return {'error': 'Faktur terkunci, tidak bisa dihapus'}

    becreff = header['becreff']
    had_update_price = header['isupdateprice']

    # Get sthist lines for reversal
    lines = await execute_query(
        pool,
        "SELECT stockid, qty, packing, qtybonus, noindex FROM sthist WHERE becreff = %s AND tipetrans = 1",
        (becreff,),
    )

    # Build per-item noindex range (needed for restore lookups after deletion)
    item_noindex = {}
    for line in lines:
        artno = line['stockid']
        ni = line['noindex']
        if artno not in item_noindex:
            item_noindex[artno] = {'min': ni, 'max': ni}
        else:
            item_noindex[artno]['min'] = min(item_noindex[artno]['min'], ni)
            item_noindex[artno]['max'] = max(item_noindex[artno]['max'], ni)

    # Phase 1 — Atomic: reverse stlastbal, delete sthist + icbym
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cursor:
            try:
                for line in lines:
                    qty_small = float(
                        Decimal(str(line['qty'])) * Decimal(str(line['packing'] or 1))
                    ) + float(line.get('qtybonus') or 0)
                    await cursor.execute(
                        "UPDATE stlastbal SET curqty = curqty - %s WHERE artno = %s AND warehouseid = 'LAPANGAN'",
                        (qty_small, line['stockid']),
                    )

                await cursor.execute(
                    "DELETE FROM sthist WHERE becreff = %s AND tipetrans = 1", (becreff,),
                )
                await cursor.execute(
                    "DELETE FROM icbym WHERE nofaktur = %s AND tipe = '1'", (fp_number,),
                )
                await conn.commit()
            except Exception:
                await conn.rollback()
                logger.exception("Faktur delete failed (Phase 1)")
                raise

    # Phase 2 — Restore stock prices from previous sthist entries
    from services.stock_restore import (
        get_previous_hbeli, get_previous_hjual,
        has_newer_hbeli_update, has_newer_hjual_update,
        get_init_hbeli, get_init_hjual,
        RESTORE_HBELI_SQL, hbeli_params, RESTORE_HJUAL_SQL, hjual_params,
    )

    for artno, ni in item_noindex.items():
        # Restore hbeli (FP always updates hbeli in stock)
        if not await has_newer_hbeli_update(pool, artno, ni['max']):
            prev = await get_previous_hbeli(pool, artno, ni['min'])
            if not prev:
                prev = await get_init_hbeli(pool, artno)
            if prev:
                try:
                    await execute_modify(pool, RESTORE_HBELI_SQL, hbeli_params(prev, artno))
                except Exception:
                    logger.warning("Failed to restore hbeli for %s", artno, exc_info=True)

        # Restore hjual + bundling (only if this FP had update_price on)
        if had_update_price and not await has_newer_hjual_update(pool, artno, ni['max']):
            prev = await get_previous_hjual(pool, artno, ni['min'])
            if not prev:
                prev = await get_init_hjual(pool, artno)
            if prev:
                try:
                    await execute_modify(pool, RESTORE_HJUAL_SQL, hjual_params(prev, artno))
                except Exception:
                    logger.warning("Failed to restore hjual for %s", artno, exc_info=True)

    from services.stock_search import invalidate_cache
    invalidate_cache()

    logger.info("Faktur deleted: %s (becreff=%d, lines=%d)", fp_number, becreff, len(lines))
    return {'ok': True, 'fp_number': fp_number, 'lines_deleted': len(lines)}


async def get_fp_history(pool, page=1, per_page=20,
                         date_from=None, date_to=None, supplier=None):
    """Retrieve recent Faktur Pembelian with optional filters."""
    offset = (page - 1) * per_page
    where = ["b.tipe = '1'"]
    params = []
    if date_from:
        where.append("b.tglfaktur >= %s")
        params.append(date_from)
    if date_to:
        where.append("b.tglfaktur <= %s")
        params.append(date_to)
    if supplier:
        where.append("b.suppid = %s")
        params.append(supplier)
    where_sql = " WHERE " + " AND ".join(where)
    rows = await execute_query(
        pool,
        f"""SELECT b.nofaktur, b.becreff, b.suppid, b.tglfaktur, b.jlhfaktur,
                  b.userid, b.uraian, v.name AS supplier_name,
                  (SELECT COUNT(*) FROM sthist s WHERE s.becreff = b.becreff AND s.tipetrans = 1) AS line_count,
                  b.isupdateprice, b.islocked
           FROM icbym b
           LEFT JOIN vendor v ON v.id = b.suppid
           {where_sql}
           ORDER BY b.tglfaktur DESC, b.nofaktur DESC
           LIMIT %s OFFSET %s""",
        (*params, per_page, offset)
    )
    count_row = await execute_single(
        pool,
        f"SELECT COUNT(*) AS total FROM icbym b{where_sql}",
        tuple(params) if params else None,
    )
    return rows, count_row['total']


async def toggle_fp_lock(pool, fp_number: str) -> dict:
    """Toggle islocked on icbym. Returns new state."""
    row = await execute_single(
        pool,
        "SELECT islocked FROM icbym WHERE nofaktur = %s AND tipe = '1'",
        (fp_number,),
    )
    if not row:
        return {'error': 'Faktur not found'}
    new_val = 0 if row['islocked'] else 1
    await execute_modify(
        pool,
        "UPDATE icbym SET islocked = %s WHERE nofaktur = %s AND tipe = '1'",
        (new_val, fp_number),
    )
    return {'ok': True, 'fp_number': fp_number, 'islocked': new_val}


async def toggle_fp_update_price(pool, fp_number: str) -> dict:
    """Toggle isupdateprice on icbym and apply/revert harga jual+bundling in stock."""
    row = await execute_single(
        pool,
        "SELECT isupdateprice, becreff FROM icbym WHERE nofaktur = %s AND tipe = '1'",
        (fp_number,),
    )
    if not row:
        return {'error': 'Faktur not found'}

    old_val = row['isupdateprice']
    new_val = 0 if old_val else 1
    fp_becreff = row['becreff']

    from services.stock_restore import (
        get_previous_hjual, has_newer_hjual_update, get_init_hjual,
        RESTORE_HJUAL_SQL, hjual_params,
    )

    # Get this FP's sthist lines (hjual + bundling + noindex)
    fp_lines = await execute_query(
        pool,
        """SELECT stockid, noindex,
                  hjual, hjual2, hjual3, hjual4, hjual5,
                  ispaketprc, over1, over2,
                  hjualo1, hjual2o1, hjual3o1, hjual4o1, hjual5o1,
                  hjualo2, hjual2o2, hjual3o2, hjual4o2, hjual5o2
           FROM sthist WHERE becreff = %s AND tipetrans = 1""",
        (fp_becreff,),
    )

    if new_val:
        # Turning ON: apply this FP's hjual to stock (skip if newer update exists)
        for line in fp_lines:
            artno = line['stockid']
            if await has_newer_hjual_update(pool, artno, line['noindex']):
                continue
            try:
                await execute_modify(pool, RESTORE_HJUAL_SQL, hjual_params(line, artno))
            except Exception:
                logger.warning("Toggle update price: apply hjual failed for %s", artno, exc_info=True)
    else:
        # Turning OFF: revert to previous hjual state (skip if newer update exists)
        for line in fp_lines:
            artno = line['stockid']
            if await has_newer_hjual_update(pool, artno, line['noindex']):
                continue
            prev = await get_previous_hjual(pool, artno, line['noindex'])
            if not prev:
                prev = await get_init_hjual(pool, artno)
            if prev:
                try:
                    await execute_modify(pool, RESTORE_HJUAL_SQL, hjual_params(prev, artno))
                except Exception:
                    logger.warning("Toggle update price: revert hjual failed for %s", artno, exc_info=True)

    # Update header flag
    await execute_modify(
        pool,
        "UPDATE icbym SET isupdateprice = %s WHERE nofaktur = %s AND tipe = '1'",
        (new_val, fp_number),
    )

    # Update sthist lines
    await execute_modify(
        pool,
        "UPDATE sthist SET isupdateprice = %s, isupdatepurchprice = %s WHERE becreff = %s AND tipetrans = 1",
        (new_val, new_val, fp_becreff),
    )

    from services.stock_search import invalidate_cache
    invalidate_cache()

    logger.info("Toggle update price for %s: %s -> %s", fp_number, old_val, new_val)
    return {'ok': True, 'fp_number': fp_number, 'isupdateprice': new_val}


async def get_fp_comparison(pool, fp_number: str) -> dict | None:
    """Get before/after comparison data for FP edit from sthist history.

    'before' = previous sthist entry (PH or FP with isupdateprice=1)
    'after'  = this FP's own sthist entry
    """
    header = await execute_single(
        pool,
        "SELECT becreff FROM icbym WHERE nofaktur = %s AND tipe = '1'",
        (fp_number,),
    )
    if not header:
        return None

    _COLS = """stockid, noindex, artpabrik, artname,
               satuanbsr, satuankcl, packing,
               hbelibsr, hbelikcl, hbelinetto,
               pctdisc1, pctdisc2, pctdisc3, pctppn,
               hjual, hjual2, hjual3, hjual4, hjual5,
               ispaketprc, over1, over2,
               hjualo1, hjual2o1, hjual3o1, hjual4o1, hjual5o1,
               hjualo2, hjual2o2, hjual3o2, hjual4o2, hjual5o2,
               qty, amount, qtybonus"""

    lines = await execute_query(
        pool,
        f"SELECT {_COLS} FROM sthist WHERE becreff = %s AND tipetrans = 1 ORDER BY noindex",
        (header['becreff'],),
    )

    def _to_dict(row):
        """Convert sthist row to frontend-compatible dict."""
        d = {}
        for k, v in dict(row).items():
            if isinstance(v, Decimal):
                d[k] = float(v)
            else:
                d[k] = v
        # Remap sthist column names to match frontend expectations
        d['artno'] = d.pop('stockid', '')
        d['satbesar'] = d.pop('satuanbsr', '')
        d['satkecil'] = d.pop('satuankcl', '')
        return d

    items = []
    for line in lines:
        artno = line['stockid']
        ni = line['noindex']

        # "after" = this FP's sthist values
        after = _to_dict(line)
        after['qty_besar'] = after.get('qty', 0)
        after['foc'] = after.pop('qtybonus', 0)
        after['shipping_cost'] = 0

        # "before" = previous sthist (PH or FP with update_price=true)
        prev = await execute_single(
            pool,
            f"""SELECT {_COLS} FROM sthist
                WHERE stockid = %s AND noindex < %s
                  AND (tipetrans = 0 OR (tipetrans = 1 AND isupdateprice = 1))
                ORDER BY noindex DESC LIMIT 1""",
            (artno, ni),
        )
        before = _to_dict(prev) if prev else None

        items.append({'artno': artno, 'before': before, 'after': after})

    return {'items': items}


async def get_fp_detail(pool, fp_number):
    """Get full detail of a specific Faktur Pembelian."""
    header = await execute_single(
        pool,
        """SELECT b.nofaktur, b.becreff, b.suppid, b.tglfaktur, b.duedate, b.uraian,
                  b.jlhfaktur, b.userid, v.name AS supplier_name, b.isupdateprice, b.islocked
           FROM icbym b
           LEFT JOIN vendor v ON v.id = b.suppid
           WHERE b.nofaktur = %s AND b.tipe = '1'""",
        (fp_number,)
    )
    if not header:
        return None
    lines = await execute_query(
        pool,
        """SELECT stockid, artpabrik, artname, qty, packing,
                  hbelibsr, hbelikcl, hbelinetto,
                  pctdisc1, pctdisc2, pctdisc3, pctppn, jlhppn,
                  satuanbsr, satuankcl,
                  hjual, hjual2, hjual3, hjual4, hjual5,
                  amount, qtybonus
           FROM sthist
           WHERE becreff = %s AND tipetrans = 1
           ORDER BY noindex""",
        (header['becreff'],)
    )
    # Fetch bundling data from stock table for each item
    artno_list = [l['stockid'] for l in lines if l.get('stockid')]
    bundling_map = {}
    if artno_list:
        placeholders = ','.join(['%s'] * len(artno_list))
        stock_rows = await execute_query(
            pool,
            f"""SELECT artno, ispaketprc, over1, over2,
                       hjualo1, hjual2o1, hjual3o1, hjual4o1, hjual5o1,
                       hjualo2, hjual2o2, hjual3o2, hjual4o2, hjual5o2
                FROM stock WHERE artno IN ({placeholders})""",
            tuple(artno_list)
        )
        for sr in stock_rows:
            b1 = b2 = None
            qty1 = float(sr.get('over1') or 0)
            if qty1:
                b1 = {'min_qty': qty1,
                       'hjual1': float(sr.get('hjualo1') or 0), 'hjual2': float(sr.get('hjual2o1') or 0),
                       'hjual3': float(sr.get('hjual3o1') or 0), 'hjual4': float(sr.get('hjual4o1') or 0),
                       'hjual5': float(sr.get('hjual5o1') or 0)}
            qty2 = float(sr.get('over2') or 0)
            if qty2:
                b2 = {'min_qty': qty2,
                       'hjual1': float(sr.get('hjualo2') or 0), 'hjual2': float(sr.get('hjual2o2') or 0),
                       'hjual3': float(sr.get('hjual3o2') or 0), 'hjual4': float(sr.get('hjual4o2') or 0),
                       'hjual5': float(sr.get('hjual5o2') or 0)}
            bundling_map[sr['artno']] = {'bundling1': b1, 'bundling2': b2}

    for line in lines:
        for k in ('qty', 'packing', 'hbelibsr', 'hbelikcl', 'hbelinetto',
                   'pctdisc1', 'pctdisc2', 'pctdisc3', 'pctppn', 'jlhppn',
                   'hjual', 'hjual2', 'hjual3', 'hjual4', 'hjual5', 'amount'):
            if line.get(k) is not None:
                line[k] = float(line[k])
        if line.get('qtybonus') is not None:
            line['qtybonus'] = int(line['qtybonus'])
        bnd = bundling_map.get(line.get('stockid'), {})
        line['bundling1'] = bnd.get('bundling1')
        line['bundling2'] = bnd.get('bundling2')
    if header.get('tglfaktur') is not None:
        header['tglfaktur'] = str(header['tglfaktur'])
    if header.get('jlhfaktur') is not None:
        header['jlhfaktur'] = float(header['jlhfaktur'])
    header['lines'] = lines
    return header


async def update_fp(pool, fp_number, supplier_id, items, order_date=None, userid=None, shipping_cost=0, update_price=True, due_date=None, uraian=None):
    """Update an existing Faktur Pembelian: reverse old stock, replace sthist lines, apply new stock.

    Same two-phase approach as commit_fp.
    """
    if not userid:
        raise POCreationError("userid is required")
    order_date = order_date or date.today()

    # Look up existing FP record
    header = await execute_single(
        pool,
        "SELECT nofaktur, becreff, suppid FROM icbym WHERE nofaktur = %s AND tipe = '1'",
        (fp_number,)
    )
    if not header:
        raise POCreationError(f"Faktur not found: {fp_number}")
    fp_becreff = header['becreff']

    # Get old lines from sthist for stlastbal reversal
    old_lines = await execute_query(
        pool,
        "SELECT stockid, qty, packing, qtybonus FROM sthist WHERE becreff = %s AND tipetrans = 1",
        (fp_becreff,)
    )

    # Build new preview
    preview = await preview_fp(pool, supplier_id, items, order_date, shipping_cost=shipping_cost)

    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cursor:
            try:
                # Reverse old stlastbal
                for old in old_lines:
                    old_qty_small = float(Decimal(str(old['qty'])) * Decimal(str(old['packing'] or 1))) + float(old.get('qtybonus') or 0)
                    await cursor.execute(
                        """UPDATE stlastbal
                           SET curqty = curqty - %s
                           WHERE artno = %s AND warehouseid = 'LAPANGAN'""",
                        (old_qty_small, old['stockid'])
                    )

                # Delete old sthist lines
                await cursor.execute("DELETE FROM sthist WHERE becreff = %s AND tipetrans = 1", (fp_becreff,))

                # Update header
                _due = due_date or order_date
                await cursor.execute(
                    """UPDATE icbym
                       SET suppid = %s, tglfaktur = %s, duedate = %s,
                           jlhfaktur = %s, userid = %s, uraian = %s, isupdateprice = %s
                       WHERE nofaktur = %s AND tipe = '1'""",
                    (supplier_id, order_date, _due,
                     preview['grand_total'], userid, uraian, 1 if update_price else 0, fp_number)
                )

                # Insert new sthist lines
                for line in preview['lines']:
                    foc = Decimal(str(line.get('foc', 0)))
                    qty_small = Decimal(str(line['qty'])) * Decimal(str(line['packing'])) + foc

                    iup = 1 if update_price else 0
                    await cursor.execute(
                        """INSERT INTO sthist
                           (stockid, artpabrik, artname, tanggal,
                            qty, beli, packing, satuanbsr, satuankcl,
                            hbelibsr, hbelikcl, hbelinetto,
                            pctdisc1, pctdisc2, pctdisc3,
                            jlhdisc1, jlhdisc2, jlhdisc3,
                            pctppn, jlhppn,
                            hjual, hjual2, hjual3, hjual4, hjual5,
                            ispaketprc, over1, over2,
                            hjualo1, hjual2o1, hjual3o1, hjual4o1, hjual5o1,
                            hjualo2, hjual2o2, hjual3o2, hjual4o2, hjual5o2,
                            amount, qtybonus,
                            suppid, whid, nofaktur, becreff, tipetrans,
                            isupdateprice, isupdatepurchprice)
                           VALUES (%s, %s, %s, %s,
                                   %s, %s, %s, %s, %s,
                                   %s, %s, %s,
                                   %s, %s, %s,
                                   %s, %s, %s,
                                   %s, %s,
                                   %s, %s, %s, %s, %s,
                                   %s, %s, %s,
                                   %s, %s, %s, %s, %s,
                                   %s, %s, %s, %s, %s,
                                   %s, %s,
                                   %s, 'LAPANGAN', %s, %s, 1,
                                   %s, %s)""",
                        (line['artno'], line['artpabrik'], line['artname'], order_date,
                         line['qty'], float(qty_small), line['packing'],
                         line['satuanbsr'], line['satuankcl'],
                         line['hbelibsr'], line['hbelikcl'], line['hbelinetto'],
                         line['pctdisc1'], line['pctdisc2'], line['pctdisc3'],
                         line['jlhdisc1'], line['jlhdisc2'], line['jlhdisc3'],
                         line['pctppn'], line['jlhppn'],
                         line['hjual'], line['hjual2'], line['hjual3'],
                         line['hjual4'], line['hjual5'],
                         _bundling_flag(line),
                         _bundling_val(line, 'bundling1', 'min_qty'),
                         _bundling_val(line, 'bundling2', 'min_qty'),
                         _bundling_val(line, 'bundling1', 'hjual1'),
                         _bundling_val(line, 'bundling1', 'hjual2'),
                         _bundling_val(line, 'bundling1', 'hjual3'),
                         _bundling_val(line, 'bundling1', 'hjual4'),
                         _bundling_val(line, 'bundling1', 'hjual5'),
                         _bundling_val(line, 'bundling2', 'hjual1'),
                         _bundling_val(line, 'bundling2', 'hjual2'),
                         _bundling_val(line, 'bundling2', 'hjual3'),
                         _bundling_val(line, 'bundling2', 'hjual4'),
                         _bundling_val(line, 'bundling2', 'hjual5'),
                         line['amount'], line.get('foc', 0),
                         supplier_id, fp_number, fp_becreff,
                         iup, iup)
                    )

                # Apply new stlastbal
                for line in preview['lines']:
                    foc = Decimal(str(line.get('foc', 0)))
                    qty_small = Decimal(str(line['qty'])) * Decimal(str(line['packing'])) + foc
                    await cursor.execute(
                        """UPDATE stlastbal
                           SET curqty = curqty + %s
                           WHERE artno = %s AND warehouseid = 'LAPANGAN'""",
                        (float(qty_small), line['artno'])
                    )
                    if cursor.rowcount == 0:
                        await cursor.execute(
                            """INSERT INTO stlastbal (artno, curqty, warehouseid)
                               VALUES (%s, %s, 'LAPANGAN')""",
                            (line['artno'], float(qty_small))
                        )

                await conn.commit()

            except Exception:
                await conn.rollback()
                logger.exception("Faktur update failed (Phase 1)")
                raise

    # Phase 2 — Deferred stock updates.
    # Harga beli, discounts, tax, satuan, packing: ALWAYS updated.
    # Harga jual + bundling: only when update_price=True.
    # When update_price=False, revert hjual + bundling to previous sthist state.

    for line in preview['lines']:
        try:
            if update_price:
                await execute_modify(
                    pool,
                    """UPDATE stock
                       SET hbelibsr = %s, hbelikcl = %s, hbelinetto = %s,
                           pctdisc1 = %s, pctdisc2 = %s, pctdisc3 = %s,
                           jlhdisc1 = %s, jlhdisc2 = %s, jlhdisc3 = %s,
                           pctppn = %s, jlhppn = %s,
                           hjual = %s, hjual2 = %s, hjual3 = %s,
                           hjual4 = %s, hjual5 = %s,
                           satbesar = %s, packing = %s
                       WHERE artno = %s""",
                    (line['hbelibsr'], line['hbelikcl'], line['hbelinetto_kcl'],
                     line['pctdisc1'], line['pctdisc2'], line['pctdisc3'],
                     line['jlhdisc1_kcl'], line['jlhdisc2_kcl'], line['jlhdisc3_kcl'],
                     line['pctppn'], line['jlhppn_kcl'],
                     line['hjual'], line['hjual2'], line['hjual3'],
                     line['hjual4'], line['hjual5'],
                     line['satuanbsr'], line['packing'],
                     line['artno']),
                )
            else:
                await execute_modify(
                    pool,
                    """UPDATE stock
                       SET hbelibsr = %s, hbelikcl = %s, hbelinetto = %s,
                           pctdisc1 = %s, pctdisc2 = %s, pctdisc3 = %s,
                           jlhdisc1 = %s, jlhdisc2 = %s, jlhdisc3 = %s,
                           pctppn = %s, jlhppn = %s,
                           satbesar = %s, packing = %s
                       WHERE artno = %s""",
                    (line['hbelibsr'], line['hbelikcl'], line['hbelinetto_kcl'],
                     line['pctdisc1'], line['pctdisc2'], line['pctdisc3'],
                     line['jlhdisc1_kcl'], line['jlhdisc2_kcl'], line['jlhdisc3_kcl'],
                     line['pctppn'], line['jlhppn_kcl'],
                     line['satuanbsr'], line['packing'],
                     line['artno']),
                )
                # Revert hjual + bundling from previous sthist entry
                # New sthist lines have isupdateprice=0, so get_latest_hjual skips them
                from services.stock_restore import get_latest_hjual, get_init_hjual, RESTORE_HJUAL_SQL, hjual_params
                prev_hjual = await get_latest_hjual(pool, line['artno'])
                if not prev_hjual:
                    prev_hjual = await get_init_hjual(pool, line['artno'])
                if prev_hjual:
                    try:
                        await execute_modify(pool, RESTORE_HJUAL_SQL, hjual_params(prev_hjual, line['artno']))
                    except Exception:
                        logger.warning("Revert hjual from sthist failed for %s", line['artno'], exc_info=True)
        except Exception:
            logger.warning("Deferred stock price update failed for %s", line['artno'], exc_info=True)

        if update_price:
            b1 = line.get('bundling1') or {}
            b2 = line.get('bundling2') or {}
            has_bundling = 1 if (b1.get('min_qty') or b2.get('min_qty')) else 0
            try:
                await execute_modify(
                    pool,
                    """UPDATE stock
                       SET ispaketprc = %s,
                           over1 = %s,
                           hjualo1 = %s, hjual2o1 = %s, hjual3o1 = %s, hjual4o1 = %s, hjual5o1 = %s,
                           over2 = %s,
                           hjualo2 = %s, hjual2o2 = %s, hjual3o2 = %s, hjual4o2 = %s, hjual5o2 = %s
                       WHERE artno = %s""",
                    (has_bundling,
                     b1.get('min_qty') or 0,
                     b1.get('hjual1') or 0, b1.get('hjual2') or 0, b1.get('hjual3') or 0,
                     b1.get('hjual4') or 0, b1.get('hjual5') or 0,
                     b2.get('min_qty') or 0,
                     b2.get('hjual1') or 0, b2.get('hjual2') or 0, b2.get('hjual3') or 0,
                     b2.get('hjual4') or 0, b2.get('hjual5') or 0,
                     line['artno']),
                )
            except Exception:
                logger.warning("Deferred bundling update failed for %s", line['artno'], exc_info=True)

    from services.stock_search import invalidate_cache
    invalidate_cache()

    result = {
        'fp_number': fp_number,
        'supplier_id': supplier_id,
        'order_date': order_date.isoformat(),
        'grand_total': preview['grand_total'],
        'line_count': preview['line_count'],
        'lines': preview['lines'],
    }

    _write_audit_log(f"{fp_number}_edit", result)

    logger.info("Faktur updated: %s (total=%.2f)", fp_number, preview['grand_total'])
    return result
