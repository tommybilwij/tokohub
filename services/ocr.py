"""Receipt photo OCR using Azure OpenAI GPT-4o vision."""

import json
import logging

from services.llm import vision_completion

logger = logging.getLogger(__name__)

_EXTRACT_PROMPT = """\
Extract all line items from this receipt image.
Return ONLY a JSON array, no other text. Each element must have:
- "name": item name (string)
- "qty": quantity (number)
- "price": unit price as integer without decimals (number)

Example: [{"name": "Indomie Goreng", "qty": 2, "price": 3500}]

If you cannot determine qty, default to 1. If you cannot determine price, default to 0.
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
            {'name': line.strip(), 'qty': 1, 'price': 0, 'raw_line': line.strip()}
            for line in raw.splitlines()
            if line.strip() and any(c.isalpha() for c in line)
        ]

    results = []
    for item in items:
        name = str(item.get('name', '')).strip()
        if not name:
            continue
        results.append({
            'name': name,
            'qty': float(item.get('qty', 1)),
            'price': int(item.get('price', 0)),
            'raw_line': f"{name} {item.get('qty', 1)} x {item.get('price', 0)}",
        })

    logger.info("LLM extracted %d items from %s", len(results), image_path)
    return results
