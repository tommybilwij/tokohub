"""Receipt photo OCR using Azure OpenAI GPT-4o vision."""

import json
import logging

from services.llm import vision_completion

logger = logging.getLogger(__name__)

_EXTRACT_PROMPT = """\
Extract all line items from this Indonesian purchase receipt / delivery note (surat jalan).
Return ONLY a JSON array, no other text. Each element must have:
- "name": item name (string). Include brand, variant, size (e.g. "INDOMIE GORENG 85G")
- "qty": the ORDER QUANTITY — how many units ordered/received (number). \
This is NOT the packing size (isi/pcs per carton). A receipt column labeled "QTY", "JML", or "JUMLAH" is order qty.
- "unit": unit of measure / satuan besar (string, e.g. "CTN", "BOX", "PAK", "DUS", "BAL", "KTK", "RTG", "Pcs"). If unknown, use "?"
- "packing": number of small units (pcs) per large unit (number). \
This is the ISI / packing size — how many pieces in one carton/box/pack. \
Look for indicators like "ISI 24", "24 KTK", "isi 40", "1x24", "40pcs", or a column labeled "ISI", "PACK", "PCS". \
If the receipt says "ISI 24" or shows "24" in a packing/isi column, packing is 24. \
If you cannot determine packing, default to 1.
- "price": the BUY PRICE (harga beli) per satuan besar as written on the receipt, in full Indonesian Rupiah as integer (number). \
Do NOT multiply by qty — return the price exactly as shown on the receipt. \
Indonesian receipts use period (.) or comma (,) as thousands separator. \
So "85.000" or "85,000" means 85000, "126.500" means 126500, "5.000" means 5000. \
Return the full number WITHOUT separators.

Example: [{"name": "INDOMIE GORENG 85G", "qty": 5, "unit": "CTN", "packing": 40, "price": 85000}]

If you cannot determine qty, default to 1. If you cannot determine unit, use "?". \
If you cannot determine packing, default to 1. If you cannot determine price, default to 0.
"""


def extract_lines(image_path):
    """Run GPT-4o vision on a receipt image and parse structured lines.

    Returns list of dicts: [{name, qty, price, raw_line}]
    """
    try:
        raw = vision_completion(image_path, _EXTRACT_PROMPT, temperature=0)
    except Exception:
        logger.exception("LLM vision call failed for %s", image_path)
        return []

    logger.debug("LLM raw output:\n%s", raw)

    # Strip markdown fences if present
    text = raw.strip()
    if text.startswith('```'):
        text = text.split('\n', 1)[1] if '\n' in text else text[3:]
        if text.endswith('```'):
            text = text[:-3]
        text = text.strip()

    try:
        items = json.loads(text)
    except json.JSONDecodeError:
        logger.warning("Could not parse LLM response as JSON, returning raw lines")
        return [
            {'name': line.strip(), 'qty': 1, 'unit': '?', 'packing': 1, 'price': 0, 'raw_line': line.strip()}
            for line in raw.splitlines()
            if line.strip() and any(c.isalpha() for c in line)
        ]

    results = []
    for item in items:
        name = str(item.get('name', '')).strip()
        if not name:
            continue
        unit = str(item.get('unit', '?')).strip()
        packing = int(item.get('packing', 1) or 1)
        if packing < 1:
            packing = 1
        results.append({
            'name': name,
            'qty': float(item.get('qty', 1)),
            'unit': unit if unit else '?',
            'packing': packing,
            'price': int(item.get('price', 0)),
            'raw_line': f"{name} {item.get('qty', 1)} x {item.get('price', 0)}",
        })

    logger.info("LLM extracted %d items from %s", len(results), image_path)
    return results
