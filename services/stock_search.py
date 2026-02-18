"""Fuzzy matching engine for stock items."""

import re
import time
import logging

from rapidfuzz import fuzz

from config import settings
from services.db import execute_query, execute_single
from services.alias_service import find_by_alias

logger = logging.getLogger(__name__)

# In-memory cache for stock items
_stock_cache = {'items': [], 'timestamp': 0}

# Regex for unit normalization
_UNIT_MAP = [
    (re.compile(r'\bGRAM\b'), 'G'),
    (re.compile(r'\bGR\b'), 'G'),
    (re.compile(r'\bLITER\b'), 'L'),
    (re.compile(r'\bLTR\b'), 'L'),
    (re.compile(r'\bMLTR\b'), 'ML'),
    (re.compile(r'\bKILO\b'), 'KG'),
]

_SIZE_PATTERN = re.compile(r'(\d+(?:\.\d+)?)\s*(G|KG|ML|L|GR|GRAM|LITER|LTR)\b', re.IGNORECASE)


def _normalize_text(text):
    """Uppercase, strip punctuation, normalize units."""
    text = text.upper().strip()
    text = re.sub(r'[^\w\s]', ' ', text)
    for pattern, replacement in _UNIT_MAP:
        text = pattern.sub(replacement, text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


def _extract_sizes(text):
    """Extract numeric sizes with units from text (e.g. '1600G' -> {('1600', 'G')})."""
    normalized = _normalize_text(text)
    matches = _SIZE_PATTERN.findall(normalized)
    return {(num, unit.upper()) for num, unit in matches}


def _load_stock_cache():
    """Refresh the in-memory stock list if stale."""
    now = time.time()
    if _stock_cache['items'] and (now - _stock_cache['timestamp']) < settings.fuzzy_cache_ttl:
        return _stock_cache['items']

    rows = execute_query(
        """SELECT artno, artpabrik, artname, suppid, satbesar, satkecil,
                  packing, hbelibsr, hbelikcl, pctdisc1, pctppn, hjual
           FROM stock
           WHERE isactive = 1
           ORDER BY artname"""
    )

    items = []
    for row in rows:
        row['_normalized'] = _normalize_text(row.get('artname') or '')
        row['_sizes'] = _extract_sizes(row.get('artname') or '')
        items.append(row)

    _stock_cache['items'] = items
    _stock_cache['timestamp'] = now
    logger.info("Stock cache refreshed: %d active items", len(items))
    return items


def invalidate_cache():
    """Force a cache refresh on next search."""
    _stock_cache['timestamp'] = 0


def _compute_score(query_normalized, query_sizes, candidate):
    """Compute composite fuzzy score for a candidate."""
    candidate_name = candidate['_normalized']

    score_token_set = fuzz.token_set_ratio(query_normalized, candidate_name)
    score_token_sort = fuzz.token_sort_ratio(query_normalized, candidate_name)
    score_partial = fuzz.partial_ratio(query_normalized, candidate_name)

    composite = (
        score_token_set * 0.45
        + score_token_sort * 0.35
        + score_partial * 0.20
    )

    # Bonus for matching numeric sizes
    if query_sizes and candidate['_sizes']:
        if query_sizes & candidate['_sizes']:
            composite = min(100, composite + 10)

    return round(composite, 1)


def search_stock(query, top_n=None, min_score=None, score_against=None):
    """
    Multi-pass search for stock items.

    Args:
        query: Search text
        top_n: Max results
        min_score: Minimum fuzzy score
        score_against: If provided, scores are computed against this text
                       instead of query (used when filtering in match modal)

    Returns list of dicts: [{artno, artname, score, match_type, ...}]
    Match types: 'alias', 'barcode', 'fuzzy'
    """
    top_n = top_n or settings.fuzzy_top_n
    min_score = min_score if min_score is not None else settings.fuzzy_min_score
    query = query.strip()
    if not query:
        return []

    pinned = []

    # Pass 1: Alias lookup
    alias_artno = find_by_alias(query)
    if alias_artno:
        stock = execute_single(
            """SELECT artno, artpabrik, artname, suppid, satbesar, satkecil,
                      packing, hbelibsr, hbelikcl, pctdisc1, pctppn, hjual
               FROM stock WHERE artno = %s""",
            (alias_artno,)
        )
        if stock:
            stock['score'] = 100.0
            stock['match_type'] = 'alias'
            pinned.append(stock)

    # Pass 2: Barcode match (8-13 digits)
    if re.match(r'^\d{8,13}$', query):
        stock = execute_single(
            """SELECT artno, artpabrik, artname, suppid, satbesar, satkecil,
                      packing, hbelibsr, hbelikcl, pctdisc1, pctppn, hjual
               FROM stock WHERE artpabrik = %s AND isactive = 1""",
            (query,)
        )
        if stock and stock['artno'] not in {p['artno'] for p in pinned}:
            stock['score'] = 100.0
            stock['match_type'] = 'barcode'
            pinned.append(stock)

    # Pass 3: Fuzzy match against cached items
    pinned_artnos = {p['artno'] for p in pinned}
    items = _load_stock_cache()
    query_normalized = _normalize_text(query)
    query_sizes = _extract_sizes(query)

    # Score against a different text if provided (e.g. receipt name)
    score_text = score_against.strip() if score_against else None
    score_normalized = _normalize_text(score_text) if score_text else query_normalized
    score_sizes = _extract_sizes(score_text) if score_text else query_sizes

    scored = []
    for item in items:
        if item['artno'] in pinned_artnos:
            continue
        search_score = _compute_score(query_normalized, query_sizes, item)
        if search_score >= min_score:
            display_score = _compute_score(score_normalized, score_sizes, item) if score_text else search_score
            result = {k: v for k, v in item.items() if not k.startswith('_')}
            result['score'] = display_score
            result['match_type'] = 'fuzzy'
            scored.append(result)

    scored.sort(key=lambda x: x['score'], reverse=True)
    return pinned + scored[:top_n]
