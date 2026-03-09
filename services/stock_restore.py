"""Helpers for restoring stock prices from sthist history.

When reverting a transaction (delete, update, toggle), these helpers
find the correct "before" state by looking at previous sthist entries.

Key rules:
- Precedence is determined by tanggal (invoice date) first, then noindex
  as tiebreaker for same-date entries.  This means a backdated FP will
  NOT overwrite prices set by a newer-dated FP or PH.
- Only FP (tipetrans=1) updates hbeli in stock (always, regardless of isupdateprice)
- Only PH (tipetrans=0) and FP with isupdateprice=1 update hjual in stock
- Both FP and PH sthist entries have valid hbeli values
  (FP sets them directly, PH copies from stock at that time)
"""

import logging
from services.db import execute_single

logger = logging.getLogger(__name__)

# Ordering clause used throughout: tanggal first, noindex as tiebreaker
_NEWER = "(tanggal > %s OR (tanggal = %s AND noindex > %s))"
_OLDER = "(tanggal < %s OR (tanggal = %s AND noindex < %s))"


# ---------------------------------------------------------------------------
# Previous state lookups
# ---------------------------------------------------------------------------

async def get_previous_hjual(pool, artno: str, tanggal, noindex: int) -> dict | None:
    """Find hjual/bundling state from the most recent price-updating
    sthist entry before a given (tanggal, noindex)."""
    return await execute_single(
        pool,
        f"""SELECT hjual, hjual2, hjual3, hjual4, hjual5,
                  ispaketprc, over1, over2,
                  hjualo1, hjual2o1, hjual3o1, hjual4o1, hjual5o1,
                  hjualo2, hjual2o2, hjual3o2, hjual4o2, hjual5o2
           FROM sthist
           WHERE stockid = %s AND {_OLDER}
             AND (tipetrans = 0 OR (tipetrans = 1 AND isupdateprice = 1))
           ORDER BY tanggal DESC, noindex DESC LIMIT 1""",
        (artno, tanggal, tanggal, noindex),
    )


async def get_latest_hjual(pool, artno: str) -> dict | None:
    """Find the most recent hjual-updating sthist entry for an item.

    Useful after update_fp with update_price=False: the new sthist lines
    have isupdateprice=0 so they are excluded by the filter automatically.
    """
    return await execute_single(
        pool,
        """SELECT hjual, hjual2, hjual3, hjual4, hjual5,
                  ispaketprc, over1, over2,
                  hjualo1, hjual2o1, hjual3o1, hjual4o1, hjual5o1,
                  hjualo2, hjual2o2, hjual3o2, hjual4o2, hjual5o2
           FROM sthist
           WHERE stockid = %s
             AND (tipetrans = 0 OR (tipetrans = 1 AND isupdateprice = 1))
           ORDER BY tanggal DESC, noindex DESC LIMIT 1""",
        (artno,),
    )


async def get_previous_hbeli(pool, artno: str, tanggal, noindex: int) -> dict | None:
    """Find hbeli/discount/packing state from the most recent
    sthist entry (FP or PH) before a given (tanggal, noindex)."""
    return await execute_single(
        pool,
        f"""SELECT hbelibsr, hbelikcl, hbelinetto,
                  pctdisc1, pctdisc2, pctdisc3, pctppn,
                  jlhdisc1, jlhdisc2, jlhdisc3, jlhppn,
                  packing, satuanbsr AS satbesar, satuankcl AS satkecil
           FROM sthist
           WHERE stockid = %s AND {_OLDER}
             AND tipetrans IN (0, 1)
           ORDER BY tanggal DESC, noindex DESC LIMIT 1""",
        (artno, tanggal, tanggal, noindex),
    )


# ---------------------------------------------------------------------------
# Newer-update checks
# ---------------------------------------------------------------------------

async def has_newer_hjual_update(pool, artno: str, tanggal, noindex: int) -> bool:
    """Check if a newer (by tanggal, then noindex) PH or FP-with-update
    has already overwritten hjual."""
    row = await execute_single(
        pool,
        f"""SELECT 1 FROM sthist
           WHERE stockid = %s AND {_NEWER}
             AND (tipetrans = 0 OR (tipetrans = 1 AND isupdateprice = 1))
           LIMIT 1""",
        (artno, tanggal, tanggal, noindex),
    )
    return bool(row)


async def has_newer_hbeli_update(pool, artno: str, tanggal, noindex: int) -> bool:
    """Check if a newer (by tanggal, then noindex) FP has already overwritten hbeli."""
    row = await execute_single(
        pool,
        f"""SELECT 1 FROM sthist
           WHERE stockid = %s AND {_NEWER}
             AND tipetrans = 1
           LIMIT 1""",
        (artno, tanggal, tanggal, noindex),
    )
    return bool(row)


# ---------------------------------------------------------------------------
# Init-value fallbacks (first-ever transaction for an item)
# Used only by delete operations where the transaction is fully removed.
# Toggle/edit operations keep current stock value when no previous entry.
# ---------------------------------------------------------------------------

async def get_init_hjual(pool, artno: str) -> dict | None:
    """Fallback: get initial hjual values from stock init* fields."""
    return await execute_single(
        pool,
        """SELECT inithjual AS hjual, inithjual2 AS hjual2, inithjual3 AS hjual3,
                  inithjual4 AS hjual4, inithjual5 AS hjual5,
                  0 AS ispaketprc, 0 AS over1, 0 AS over2,
                  inithjualo1 AS hjualo1, inithjual2o1 AS hjual2o1,
                  inithjual3o1 AS hjual3o1, inithjual4o1 AS hjual4o1,
                  inithjual5o1 AS hjual5o1,
                  inithjualo2 AS hjualo2, inithjual2o2 AS hjual2o2,
                  inithjual3o2 AS hjual3o2, inithjual4o2 AS hjual4o2,
                  inithjual5o2 AS hjual5o2
           FROM stock WHERE artno = %s""",
        (artno,),
    )


async def get_init_hbeli(pool, artno: str) -> dict | None:
    """Fallback: get initial hbeli values from stock init* fields."""
    return await execute_single(
        pool,
        """SELECT inithbelibsr AS hbelibsr, inithbelikcl AS hbelikcl,
                  inithbelinetto AS hbelinetto,
                  initpctdisc1 AS pctdisc1, initpctdisc2 AS pctdisc2,
                  initpctdisc3 AS pctdisc3, initpctppn AS pctppn,
                  initjlhdisc1 AS jlhdisc1, initjlhdisc2 AS jlhdisc2,
                  initjlhdisc3 AS jlhdisc3, initjlhppn AS jlhppn,
                  initpacking AS packing, satbesar, satkecil
           FROM stock WHERE artno = %s""",
        (artno,),
    )


# ---------------------------------------------------------------------------
# SQL + param builders for stock UPDATE
# ---------------------------------------------------------------------------

RESTORE_HJUAL_SQL = """UPDATE stock SET
    hjual=%s, hjual2=%s, hjual3=%s, hjual4=%s, hjual5=%s,
    ispaketprc=%s, over1=%s, over2=%s,
    hjualo1=%s, hjual2o1=%s, hjual3o1=%s, hjual4o1=%s, hjual5o1=%s,
    hjualo2=%s, hjual2o2=%s, hjual3o2=%s, hjual4o2=%s, hjual5o2=%s
WHERE artno=%s"""


def hjual_params(prev, artno):
    """Build params tuple for RESTORE_HJUAL_SQL."""
    return (
        prev['hjual'], prev['hjual2'], prev['hjual3'], prev['hjual4'], prev['hjual5'],
        prev['ispaketprc'], prev['over1'], prev['over2'],
        prev['hjualo1'], prev['hjual2o1'], prev['hjual3o1'],
        prev['hjual4o1'], prev['hjual5o1'],
        prev['hjualo2'], prev['hjual2o2'], prev['hjual3o2'],
        prev['hjual4o2'], prev['hjual5o2'],
        artno,
    )


RESTORE_HBELI_SQL = """UPDATE stock SET
    hbelibsr=%s, hbelikcl=%s, hbelinetto=%s,
    pctdisc1=%s, pctdisc2=%s, pctdisc3=%s, pctppn=%s,
    jlhdisc1=%s, jlhdisc2=%s, jlhdisc3=%s, jlhppn=%s,
    packing=%s, satbesar=%s, satkecil=%s
WHERE artno=%s"""


def hbeli_params(prev, artno):
    """Build params tuple for RESTORE_HBELI_SQL."""
    return (
        prev['hbelibsr'], prev['hbelikcl'], prev['hbelinetto'],
        prev['pctdisc1'], prev['pctdisc2'], prev['pctdisc3'], prev['pctppn'],
        prev['jlhdisc1'], prev['jlhdisc2'], prev['jlhdisc3'], prev['jlhppn'],
        prev['packing'], prev['satbesar'], prev['satkecil'],
        artno,
    )
