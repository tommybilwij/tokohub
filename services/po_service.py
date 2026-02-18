"""Purchase Order creation and stock balance update.

No table locking — all writes use atomic single-row operations
(UPDATE ... SET col = col + X) so MyPosse POS and this app can
read and write concurrently without blocking each other.
"""

import json
import os
import logging
from datetime import date, datetime
from decimal import Decimal

from config import settings
from services.db import get_connection

logger = logging.getLogger(__name__)


class POCreationError(Exception):
    """Raised when PO creation fails."""


def _generate_po_number(cursor, order_date):
    """Generate PO number: PP{YYMMDD}{5-digit-seq}.

    Finds the highest existing sequence for this date and increments.
    """
    prefix = f"PP{order_date.strftime('%y%m%d')}"
    cursor.execute(
        "SELECT noorder FROM icpom WHERE noorder LIKE %s ORDER BY noorder DESC LIMIT 1",
        (f"{prefix}%",)
    )
    row = cursor.fetchone()
    if row:
        last_seq = int(row['noorder'][-5:])
        seq = last_seq + 1
    else:
        seq = 1
    return f"{prefix}{seq:05d}"


def _generate_fp_number(cursor, order_date):
    """Generate Faktur Pembelian number: FP{YYMMDD}{5-digit-seq}."""
    prefix = f"FP{order_date.strftime('%y%m%d')}"
    cursor.execute(
        "SELECT nofaktur FROM sthist WHERE nofaktur LIKE %s ORDER BY nofaktur DESC LIMIT 1",
        (f"{prefix}%",)
    )
    row = cursor.fetchone()
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


def get_stock_details(artno_list):
    """Load full stock details for a list of artnos."""
    if not artno_list:
        return {}
    from services.db import execute_query
    placeholders = ','.join(['%s'] * len(artno_list))
    rows = execute_query(
        f"""SELECT artno, artpabrik, artname, suppid, deptid,
                   satbesar, satkecil, packing,
                   hbelibsr, hbelikcl, pctdisc1, pctdisc2, pctdisc3,
                   pctppn, hjual, hjual2, hjual3
            FROM stock
            WHERE artno IN ({placeholders})""",
        tuple(artno_list)
    )
    return {row['artno']: row for row in rows}


def preview_po(supplier_id, items, order_date=None):
    """Build a PO preview without committing.

    Args:
        supplier_id: Vendor ID
        items: List of {artno, qty, price_override (optional)}
        order_date: Date for PO (defaults to today)

    Returns:
        dict with header info and line items with calculated pricing
    """
    order_date = order_date or date.today()
    artno_list = [item['artno'] for item in items]
    stock_map = get_stock_details(artno_list)

    lines = []
    grand_total = Decimal('0')

    for item in items:
        artno = item['artno']
        stock = stock_map.get(artno)
        if not stock:
            raise POCreationError(f"Stock item not found: {artno}")

        qty = Decimal(str(item['qty']))
        packing = stock['packing'] or Decimal('1')

        # Use override price if provided, else stock's hbelibsr
        if item.get('price_override') and Decimal(str(item['price_override'])) > 0:
            hbelibsr = Decimal(str(item['price_override']))
        else:
            hbelibsr = stock['hbelibsr'] or Decimal('0')

        # Calculate small-unit price
        hbelikcl = hbelibsr / packing if packing else hbelibsr

        # Discounts
        pctdisc1 = stock['pctdisc1'] or Decimal('0')
        pctdisc2 = stock['pctdisc2'] or Decimal('0')
        pctdisc3 = stock['pctdisc3'] or Decimal('0')

        disc1 = hbelibsr * pctdisc1 / 100
        after_disc1 = hbelibsr - disc1
        disc2 = after_disc1 * pctdisc2 / 100
        after_disc2 = after_disc1 - disc2
        disc3 = after_disc2 * pctdisc3 / 100
        hbelinetto = after_disc2 - disc3

        # Tax
        pctppn = stock['pctppn'] or Decimal('0')
        ppn = hbelinetto * pctppn / 100

        amount = (hbelinetto + ppn) * qty

        lines.append({
            'artno': artno,
            'artpabrik': stock['artpabrik'] or '',
            'artname': stock['artname'] or '',
            'qty': float(qty),
            'packing': float(packing),
            'satuanbsr': stock['satbesar'] or '',
            'satuankcl': stock['satkecil'] or '',
            'hbelibsr': float(hbelibsr),
            'hbelikcl': float(hbelikcl),
            'hbelinetto': float(hbelinetto),
            'pctdisc1': float(pctdisc1),
            'pctdisc2': float(pctdisc2),
            'pctdisc3': float(pctdisc3),
            'pctppn': float(pctppn),
            'jlhppn': float(ppn * qty),
            'hjual': float(stock['hjual'] or 0),
            'amount': float(amount),
        })
        grand_total += amount

    return {
        'supplier_id': supplier_id,
        'order_date': order_date.isoformat(),
        'lines': lines,
        'grand_total': float(grand_total),
        'line_count': len(lines),
    }


def commit_po(supplier_id, items, order_date=None, userid=None):
    """Create PO in database without locking.

    Each write is an atomic single-row operation, so MyPosse POS
    can continue reading and writing concurrently.

    Args:
        supplier_id: Vendor ID
        items: List of {artno, qty, price_override (optional)}
        order_date: Date for PO (defaults to today)
        userid: User creating the PO

    Returns:
        dict with PO number and summary
    """
    if not userid:
        raise POCreationError("userid is required")
    order_date = order_date or date.today()
    preview = preview_po(supplier_id, items, order_date)

    with get_connection() as conn:
        cursor = conn.cursor(dictionary=True)
        try:
            # Read current becreff counters from nextrec
            cursor.execute("SELECT newpo, newpurch FROM nextrec LIMIT 1")
            nextrec_row = cursor.fetchone()
            if not nextrec_row:
                raise POCreationError("nextrec table is empty")
            becreff = nextrec_row['newpo']
            fp_becreff = nextrec_row['newpurch']

            # Generate PO and FP numbers
            po_number = _generate_po_number(cursor, order_date)
            fp_number = _generate_fp_number(cursor, order_date)

            # Insert PO header (icpom)
            cursor.execute(
                """INSERT INTO icpom
                   (noorder, becreff, suppid, tglorder, duedate,
                    jlhfaktur, userid, isclosed, lastprd)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, 0, 0)""",
                (po_number, becreff, supplier_id, order_date,
                 order_date, preview['grand_total'], userid)
            )

            # Insert Purchase Invoice header (icbym)
            cursor.execute(
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
                cursor.execute(
                    """INSERT INTO icpos
                       (becreff, stockid, artpabrik, artname, qty,
                        hbelibsr, hbelikcl, hbelinetto,
                        pctdisc1, pctdisc2, pctdisc3,
                        jlhdisc1, jlhdisc2, jlhdisc3,
                        pctppn, jlhppn,
                        packing, satuanbsr, satuankcl,
                        hjual, amount)
                       VALUES (%s, %s, %s, %s, %s,
                               %s, %s, %s,
                               %s, %s, %s,
                               0, 0, 0,
                               %s, %s,
                               %s, %s, %s,
                               %s, %s)""",
                    (becreff, line['artno'], line['artpabrik'], line['artname'],
                     line['qty'],
                     line['hbelibsr'], line['hbelikcl'], line['hbelinetto'],
                     line['pctdisc1'], line['pctdisc2'], line['pctdisc3'],
                     line['pctppn'], line['jlhppn'],
                     line['packing'], line['satuanbsr'], line['satuankcl'],
                     line['hjual'], line['amount'])
                )

                # Atomic balance update: curqty += qty * packing
                qty_small_unit = Decimal(str(line['qty'])) * Decimal(str(line['packing']))
                cursor.execute(
                    """UPDATE stlastbal
                       SET curqty = curqty + %s
                       WHERE artno = %s AND warehouseid = 'LAPANGAN'""",
                    (float(qty_small_unit), line['artno'])
                )

                # If no row existed, insert it
                if cursor.rowcount == 0:
                    cursor.execute(
                        """INSERT INTO stlastbal (artno, curqty, warehouseid)
                           VALUES (%s, %s, 'LAPANGAN')""",
                        (line['artno'], float(qty_small_unit))
                    )

                # Insert stock history (sthist) for purchase tracking
                cursor.execute(
                    """INSERT INTO sthist
                       (stockid, artpabrik, artname, tanggal,
                        qty, beli, packing, satuanbsr, satuankcl,
                        hbelibsr, hbelikcl, hbelinetto,
                        pctdisc1, pctdisc2, pctdisc3,
                        jlhdisc1, jlhdisc2, jlhdisc3,
                        pctppn, jlhppn,
                        hjual, amount,
                        suppid, whid, nofaktur, becreff, tipetrans,
                        isupdateprice, isupdatepurchprice)
                       VALUES (%s, %s, %s, %s,
                               %s, %s, %s, %s, %s,
                               %s, %s, %s,
                               %s, %s, %s,
                               0, 0, 0,
                               %s, %s,
                               %s, %s,
                               %s, 'LAPANGAN', %s, %s, 1,
                               1, 1)""",
                    (line['artno'], line['artpabrik'], line['artname'], order_date,
                     line['qty'], float(qty_small_unit), line['packing'],
                     line['satuanbsr'], line['satuankcl'],
                     line['hbelibsr'], line['hbelikcl'], line['hbelinetto'],
                     line['pctdisc1'], line['pctdisc2'], line['pctdisc3'],
                     line['pctppn'], line['jlhppn'],
                     line['hjual'], line['amount'],
                     supplier_id, fp_number, fp_becreff)
                )

            # Atomic counter increments
            cursor.execute("UPDATE nextrec SET newpo = newpo + 1, newpurch = newpurch + 1")

            conn.commit()

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

        except Exception:
            conn.rollback()
            logger.exception("PO creation failed")
            raise
        finally:
            cursor.close()


def get_po_history(page=1, per_page=20):
    """Retrieve recent POs."""
    from services.db import execute_query, execute_single
    offset = (page - 1) * per_page
    rows = execute_query(
        """SELECT m.noorder, m.becreff, m.suppid, m.tglorder, m.jlhfaktur,
                  m.userid, v.name AS supplier_name,
                  (SELECT COUNT(*) FROM icpos s WHERE s.becreff = m.becreff) AS line_count
           FROM icpom m
           LEFT JOIN vendor v ON v.id = m.suppid
           ORDER BY m.tglorder DESC, m.noorder DESC
           LIMIT %s OFFSET %s""",
        (per_page, offset)
    )
    count_row = execute_single(
        "SELECT COUNT(*) AS total FROM icpom"
    )
    return rows, count_row['total']


def get_po_detail(po_number):
    """Get full detail of a specific PO."""
    from services.db import execute_query, execute_single
    header = execute_single(
        """SELECT m.noorder, m.becreff, m.suppid, m.tglorder, m.jlhfaktur,
                  m.userid, v.name AS supplier_name
           FROM icpom m
           LEFT JOIN vendor v ON v.id = m.suppid
           WHERE m.noorder = %s""",
        (po_number,)
    )
    if not header:
        return None
    lines = execute_query(
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
