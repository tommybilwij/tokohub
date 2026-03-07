"""PO snapshot service — captures before/after stock prices on faktur submission."""

import json
import logging
from decimal import Decimal

from services.db import execute_query, execute_single, execute_modify

logger = logging.getLogger(__name__)

# Fields to capture from stock table for before/after comparison
_STOCK_FIELDS = (
    'artno', 'artname', 'satbesar', 'satkecil', 'packing',
    'hbelibsr', 'hbelikcl', 'hbelinetto',
    'pctdisc1', 'pctdisc2', 'pctdisc3', 'pctppn',
    'hjual', 'hjual2', 'hjual3', 'hjual4', 'hjual5',
    'ispaketprc', 'over1', 'over2',
    'hjualo1', 'hjual2o1', 'hjual3o1', 'hjual4o1', 'hjual5o1',
    'hjualo2', 'hjual2o2', 'hjual3o2', 'hjual4o2', 'hjual5o2',
)


def _decimal_default(obj):
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError


async def capture_before(pool, artnos: list[str]) -> dict:
    """Capture current stock state for a list of artnos. Returns {artno: {fields...}}."""
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
        d = dict(r)
        # stock.hbelinetto is netto per pcs; remap to match build_after naming
        netto_kcl = float(d.get('hbelinetto') or 0)
        packing = float(d.get('packing') or 1)
        d['hbelinetto_kcl'] = netto_kcl
        d['hbelinetto'] = netto_kcl * packing if packing else netto_kcl
        result[d['artno']] = d
    return result


def build_after(preview_lines: list[dict]) -> dict:
    """Build after-state from preview lines (what will be written to stock)."""
    result = {}
    for line in preview_lines:
        after = {
            'artno': line['artno'],
            'artname': line.get('artname', ''),
            'satbesar': line.get('satuanbsr', ''),
            'satkecil': line.get('satuankcl', ''),
            'packing': line.get('packing', 0),
            'hbelibsr': line.get('hbelibsr', 0),
            'hbelikcl': line.get('hbelikcl', 0),
            'hbelinetto': line.get('hbelinetto', 0),
            'hbelinetto_kcl': line.get('hbelinetto_kcl', 0),
            'pctdisc1': line.get('pctdisc1', 0),
            'pctdisc2': line.get('pctdisc2', 0),
            'pctdisc3': line.get('pctdisc3', 0),
            'pctppn': line.get('pctppn', 0),
            'hjual': line.get('hjual', 0),
            'hjual2': line.get('hjual2', 0),
            'hjual3': line.get('hjual3', 0),
            'hjual4': line.get('hjual4', 0),
            'hjual5': line.get('hjual5', 0),
            # PO line data
            'qty': line.get('qty', 0),
            'qty_besar': line.get('qty_besar', 0),
            'amount': line.get('amount', 0),
            'foc': line.get('foc', 0),
            'jlhppn': line.get('jlhppn', 0),  # includes biaya kirim (shipping added to ppn in DB)
        }
        b1 = line.get('bundling1') or {}
        b2 = line.get('bundling2') or {}
        after['ispaketprc'] = 1 if (b1.get('min_qty') or b2.get('min_qty')) else 0
        after['over1'] = b1.get('min_qty', 0)
        after['hjualo1'] = b1.get('hjual1', 0)
        after['hjual2o1'] = b1.get('hjual2', 0)
        after['hjual3o1'] = b1.get('hjual3', 0)
        after['hjual4o1'] = b1.get('hjual4', 0)
        after['hjual5o1'] = b1.get('hjual5', 0)
        after['over2'] = b2.get('min_qty', 0)
        after['hjualo2'] = b2.get('hjual1', 0)
        after['hjual2o2'] = b2.get('hjual2', 0)
        after['hjual3o2'] = b2.get('hjual3', 0)
        after['hjual4o2'] = b2.get('hjual4', 0)
        after['hjual5o2'] = b2.get('hjual5', 0)
        result[line['artno']] = after
    return result


async def save_snapshot(pool, po_number: str, before: dict, after: dict,
                        created_by: str = '', meta: dict | None = None) -> None:
    """Save before/after snapshot to tokohub.po_snapshots."""
    items = []
    all_artnos = set(list(before.keys()) + list(after.keys()))
    for artno in sorted(all_artnos):
        items.append({
            'artno': artno,
            'before': before.get(artno),
            'after': after.get(artno),
        })
    data = {'items': items}
    if meta:
        data['meta'] = meta
    snapshot = json.dumps(data, default=_decimal_default)
    await execute_modify(
        pool,
        "INSERT INTO tokohub.po_snapshots (po_number, snapshot_json, created_by) VALUES (%s, %s, %s)",
        (po_number, snapshot, created_by),
    )
    logger.info("Snapshot saved for PO %s (%d items)", po_number, len(items))


async def get_snapshot(pool, po_number: str) -> dict | None:
    """Get the latest snapshot for a PO."""
    row = await execute_single(
        pool,
        "SELECT snapshot_json, created_by, created_at FROM tokohub.po_snapshots "
        "WHERE po_number = %s ORDER BY id DESC LIMIT 1",
        (po_number,),
    )
    if not row:
        return None
    return {
        'po_number': po_number,
        'created_by': row['created_by'],
        'created_at': row['created_at'].isoformat() if row['created_at'] else '',
        **json.loads(row['snapshot_json']),
    }


async def get_snapshots_for_po(pool, po_number: str) -> list[dict]:
    """Get all snapshots for a PO (newest first)."""
    rows = await execute_query(
        pool,
        "SELECT id, po_number, created_by, created_at FROM tokohub.po_snapshots "
        "WHERE po_number = %s ORDER BY id DESC",
        (po_number,),
    )
    return rows


async def delete_all_snapshots(pool) -> int:
    """Delete all snapshots. Returns rows deleted."""
    row = await execute_single(pool, "SELECT COUNT(*) as cnt FROM tokohub.po_snapshots")
    count = row['cnt'] if row else 0
    if count:
        await execute_modify(pool, "TRUNCATE TABLE tokohub.po_snapshots")
    return count
