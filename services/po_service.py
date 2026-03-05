"""Purchase Order creation and stock balance update (async).

No table locking — all writes use atomic single-row operations
(UPDATE ... SET col = col + X) so MyPosse POS and this app can
read and write concurrently without blocking each other.
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
from services.db import execute_query, execute_single

logger = logging.getLogger(__name__)


class POCreationError(Exception):
    """Raised when PO creation fails."""


async def _generate_po_number(cursor, order_date):
    """Generate PO number: PP{YYMMDD}{5-digit-seq}."""
    prefix = f"PP{order_date.strftime('%y%m%d')}"
    await cursor.execute(
        "SELECT noorder FROM icpom WHERE noorder LIKE %s ORDER BY noorder DESC LIMIT 1",
        (f"{prefix}%",)
    )
    row = await cursor.fetchone()
    if row:
        last_seq = int(row['noorder'][-5:])
        seq = last_seq + 1
    else:
        seq = 1
    return f"{prefix}{seq:05d}"


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


def _write_audit_log(po_number, po_data):
    """Write PO data as JSON to audit log."""
    os.makedirs(str(settings.log_folder), exist_ok=True)
    log_file = os.path.join(str(settings.log_folder), f"{po_number}.json")
    with open(log_file, 'w') as f:
        json.dump(po_data, f, indent=2, default=_decimal_default)
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


async def preview_po(pool, supplier_id, items, order_date=None, shipping_cost=0):
    """Build a PO preview without committing.

    Args:
        pool: aiomysql connection pool
        supplier_id: Vendor ID
        items: List of {artno, qty, price_override (optional)}
        order_date: Date for PO (defaults to today)
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
        disc3 = after_disc2 * pctdisc3 / 100
        hbelinetto = after_disc2 - disc3

        # Per-small-unit discount amounts (for stock table)
        disc1_kcl = hbelikcl * pctdisc1 / 100
        after_disc1_kcl = hbelikcl - disc1_kcl
        disc2_kcl = after_disc1_kcl * pctdisc2 / 100
        after_disc2_kcl = after_disc1_kcl - disc2_kcl
        disc3_kcl = after_disc2_kcl * pctdisc3 / 100
        hbelinetto_kcl = after_disc2_kcl - disc3_kcl

        # Tax (use override if provided, else 0 — empty means no tax)
        pctppn = Decimal(str(item['ppn_override'])) if item.get('ppn_override') is not None else Decimal('0')
        ppn = hbelinetto * pctppn / 100
        ppn_kcl = hbelinetto_kcl * pctppn / 100

        amount = (hbelinetto + ppn) * qty
        netto_full = hbelinetto + ppn  # per-unit netto including PPN (before shipping)

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
        'shipping_cost': float(shipping),
    }


async def commit_po(pool, supplier_id, items, order_date=None, userid=None, shipping_cost=0):
    """Create PO in two phases to minimise lock contention with MyPosse POS.

    Phase 1 (single transaction):
        INSERT headers/lines/history, UPDATE stlastbal + nextrec, COMMIT.
        Only new-row INSERTs and brief end-of-txn UPDATEs — minimal locks.

    Phase 2 (individual auto-committed updates):
        UPDATE stock prices and DELETE/INSERT itempaket bundling per item.
        Each is a separate ~1ms transaction so MyPosse is never blocked.
        If any fail, the PO is already safely committed.

    Args:
        pool: aiomysql connection pool
        supplier_id: Vendor ID
        items: List of {artno, qty, price_override (optional)}
        order_date: Date for PO (defaults to today)
        userid: User creating the PO
        shipping_cost: Shipping cost distributed into tax

    Returns:
        dict with PO number and summary
    """
    if not userid:
        raise POCreationError("userid is required")
    order_date = order_date or date.today()
    preview = await preview_po(pool, supplier_id, items, order_date, shipping_cost=shipping_cost)

    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cursor:
            try:
                # Lock nextrec row to serialise concurrent PO creation.
                await cursor.execute("SELECT newpo, newpurch FROM nextrec LIMIT 1 FOR UPDATE")
                nextrec = await cursor.fetchone()
                if not nextrec:
                    raise POCreationError("nextrec table is empty")
                becreff = nextrec['newpo']
                fp_becreff = nextrec['newpurch']

                # Generate PO and FP numbers
                po_number = await _generate_po_number(cursor, order_date)
                fp_number = await _generate_fp_number(cursor, order_date)

                # Insert PO header (icpom)
                await cursor.execute(
                    """INSERT INTO icpom
                       (noorder, becreff, suppid, tglorder, duedate,
                        jlhfaktur, userid, isclosed, lastprd)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, 0, 0)""",
                    (po_number, becreff, supplier_id, order_date,
                     order_date, preview['grand_total'], userid)
                )

                # Insert Purchase Invoice header (icbym)
                await cursor.execute(
                    """INSERT INTO icbym
                       (nofaktur, tipe, becreff, suppid, tglfaktur, duedate,
                        jlhfaktur, lokasi, userid, noorder,
                        isupdateprice, islocked)
                       VALUES (%s, '1', %s, %s, %s, %s,
                               %s, 'LAPANGAN', %s, %s,
                               1, 0)""",
                    (fp_number, fp_becreff, supplier_id, order_date, order_date,
                     preview['grand_total'], userid, po_number)
                )

                # Insert line items and update stock balances
                for line in preview['lines']:
                    await cursor.execute(
                        """INSERT INTO icpos
                           (becreff, stockid, artpabrik, artname, qty,
                            hbelibsr, hbelikcl, hbelinetto,
                            pctdisc1, pctdisc2, pctdisc3,
                            jlhdisc1, jlhdisc2, jlhdisc3,
                            pctppn, jlhppn,
                            packing, satuanbsr, satuankcl,
                            hjual, hjual2, hjual3, hjual4, hjual5,
                            amount, qtybonus)
                           VALUES (%s, %s, %s, %s, %s,
                                   %s, %s, %s,
                                   %s, %s, %s,
                                   %s, %s, %s,
                                   %s, %s,
                                   %s, %s, %s,
                                   %s, %s, %s, %s, %s,
                                   %s, %s)""",
                        (becreff, line['artno'], line['artpabrik'], line['artname'],
                         line['qty'],
                         line['hbelibsr'], line['hbelikcl'], line['hbelinetto'],
                         line['pctdisc1'], line['pctdisc2'], line['pctdisc3'],
                         line['jlhdisc1'], line['jlhdisc2'], line['jlhdisc3'],
                         line['pctppn'], line['jlhppn'],
                         line['packing'], line['satuanbsr'], line['satuankcl'],
                         line['hjual'], line['hjual2'], line['hjual3'],
                         line['hjual4'], line['hjual5'],
                         line['amount'], line.get('foc', 0))
                    )

                    # Total small units received: qty * packing + foc
                    foc = Decimal(str(line.get('foc', 0)))
                    qty_small = Decimal(str(line['qty'])) * Decimal(str(line['packing'])) + foc

                    # Insert stock history (sthist) for purchase tracking
                    await cursor.execute(
                        """INSERT INTO sthist
                           (stockid, artpabrik, artname, tanggal,
                            qty, beli, packing, satuanbsr, satuankcl,
                            hbelibsr, hbelikcl, hbelinetto,
                            pctdisc1, pctdisc2, pctdisc3,
                            jlhdisc1, jlhdisc2, jlhdisc3,
                            pctppn, jlhppn,
                            hjual, hjual2, hjual3, hjual4, hjual5,
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
                                   %s, %s,
                                   %s, 'LAPANGAN', %s, %s, 1,
                                   1, 1)""",
                        (line['artno'], line['artpabrik'], line['artname'], order_date,
                         line['qty'], float(qty_small), line['packing'],
                         line['satuanbsr'], line['satuankcl'],
                         line['hbelibsr'], line['hbelikcl'], line['hbelinetto'],
                         line['pctdisc1'], line['pctdisc2'], line['pctdisc3'],
                         line['jlhdisc1'], line['jlhdisc2'], line['jlhdisc3'],
                         line['pctppn'], line['jlhppn'],
                         line['hjual'], line['hjual2'], line['hjual3'],
                         line['hjual4'], line['hjual5'],
                         line['amount'], line.get('foc', 0),
                         supplier_id, fp_number, fp_becreff)
                    )

                # --- stock price + bundling updates are DEFERRED to Phase 2 ---

                # Batch stock balance updates LAST, right before commit.
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

                # Increment nextrec counters
                await cursor.execute(
                    "UPDATE nextrec SET newpo = newpo + 1, newpurch = newpurch + 1"
                )

                await conn.commit()

            except Exception:
                await conn.rollback()
                logger.exception("PO creation failed (Phase 1)")
                raise

    # ------------------------------------------------------------------
    # Phase 2 — Deferred updates (separate auto-committed connections).
    # Each UPDATE/DELETE+INSERT is its own tiny transaction (~1ms lock).
    # If any fail, the PO is already safely committed.
    # ------------------------------------------------------------------
    from services.db import execute_modify
    for line in preview['lines']:
        try:
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
        except Exception:
            logger.warning("Deferred stock price update failed for %s", line['artno'], exc_info=True)

        # Update bundling (itempaket): DELETE + INSERT in one connection
        bundlings = [b for b in [line.get('bundling1'), line.get('bundling2')]
                     if b and b.get('min_qty')]
        try:
            async with pool.acquire() as bconn:
                async with bconn.cursor() as bcur:
                    await bcur.execute(
                        "DELETE FROM itempaket WHERE artno = %s",
                        (line['artno'],)
                    )
                    for i_bund, bund in enumerate(bundlings, start=1):
                        await bcur.execute(
                            """INSERT INTO itempaket
                               (artno, subartno, qty, hjual1, hjual2, hjual3, hjual4, hjual5)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                            (line['artno'], str(i_bund),
                             int(bund['min_qty']),
                             bund.get('hjual1') or 0, bund.get('hjual2') or 0,
                             bund.get('hjual3') or 0, bund.get('hjual4') or 0,
                             bund.get('hjual5') or 0)
                        )
                    await bconn.commit()
        except Exception:
            logger.warning("Deferred bundling update failed for %s", line['artno'], exc_info=True)

    # Invalidate stock search cache so next search reflects updated prices/packing
    from services.stock_search import invalidate_cache
    invalidate_cache()

    result = {
        'po_number': po_number,
        'fp_number': fp_number,
        'becreff': becreff,
        'fp_becreff': fp_becreff,
        'supplier_id': supplier_id,
        'order_date': order_date.isoformat(),
        'grand_total': preview['grand_total'],
        'line_count': preview['line_count'],
        'lines': preview['lines'],
    }

    _write_audit_log(po_number, result)
    logger.info("PO created: %s / FP %s (becreff=%d, fp_becreff=%d, total=%.2f)",
                po_number, fp_number, becreff, fp_becreff, preview['grand_total'])
    return result


async def get_po_history(pool, page=1, per_page=20):
    """Retrieve recent POs."""
    offset = (page - 1) * per_page
    rows = await execute_query(
        pool,
        """SELECT m.noorder, m.becreff, m.suppid, m.tglorder, m.jlhfaktur,
                  m.userid, v.name AS supplier_name,
                  (SELECT COUNT(*) FROM icpos s WHERE s.becreff = m.becreff) AS line_count
           FROM icpom m
           LEFT JOIN vendor v ON v.id = m.suppid
           ORDER BY m.tglorder DESC, m.noorder DESC
           LIMIT %s OFFSET %s""",
        (per_page, offset)
    )
    count_row = await execute_single(
        pool,
        "SELECT COUNT(*) AS total FROM icpom"
    )
    return rows, count_row['total']


async def get_po_detail(pool, po_number):
    """Get full detail of a specific PO."""
    header = await execute_single(
        pool,
        """SELECT m.noorder, m.becreff, m.suppid, m.tglorder, m.jlhfaktur,
                  m.userid, v.name AS supplier_name
           FROM icpom m
           LEFT JOIN vendor v ON v.id = m.suppid
           WHERE m.noorder = %s""",
        (po_number,)
    )
    if not header:
        return None
    lines = await execute_query(
        pool,
        """SELECT stockid, artpabrik, artname, qty, packing,
                  hbelibsr, hbelikcl, hbelinetto,
                  pctdisc1, pctdisc2, pctdisc3, pctppn, jlhppn,
                  satuanbsr, satuankcl, hjual, amount
           FROM icpos
           WHERE becreff = %s
           ORDER BY nourut""",
        (header['becreff'],)
    )
    header['lines'] = lines
    return header
