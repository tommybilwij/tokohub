"""Receipt photo OCR using Tesseract."""

import re
import logging

from PIL import Image, ImageEnhance, ImageFilter
import pytesseract

logger = logging.getLogger(__name__)

# Common receipt line patterns:
#   "Item Name    2 x 15000"   or   "Item Name  2  15000"
_LINE_PATTERN = re.compile(
    r'^(.+?)\s+'           # item name (non-greedy)
    r'(\d+(?:[.,]\d+)?)'  # qty
    r'\s*[xX×]?\s*'       # optional "x" separator
    r'(\d[\d.,]*)?'        # optional price
    r'\s*$'
)


def preprocess_image(image_path):
    """Apply preprocessing to improve OCR accuracy."""
    img = Image.open(image_path)

    # Convert to grayscale
    img = img.convert('L')

    # Boost contrast
    img = ImageEnhance.Contrast(img).enhance(2.0)

    # Sharpen
    img = img.filter(ImageFilter.SHARPEN)

    # Binarize (threshold)
    img = img.point(lambda x: 255 if x > 140 else 0, '1')

    return img


def extract_lines(image_path):
    """Run OCR on a receipt image and parse structured lines.

    Returns list of dicts: [{name, qty, price, raw_line}]
    """
    img = preprocess_image(image_path)
    raw_text = pytesseract.image_to_string(img, lang='ind+eng')
    logger.debug("OCR raw output:\n%s", raw_text)

    results = []
    for line in raw_text.splitlines():
        line = line.strip()
        if not line or len(line) < 3:
            continue

        match = _LINE_PATTERN.match(line)
        if match:
            name = match.group(1).strip()
            qty_str = match.group(2).replace(',', '.')
            price_str = (match.group(3) or '0').replace(',', '').replace('.', '')

            results.append({
                'name': name,
                'qty': float(qty_str),
                'price': int(price_str) if price_str.isdigit() else 0,
                'raw_line': line,
            })
        else:
            # Include unmatched lines as name-only for user to edit
            if any(c.isalpha() for c in line):
                results.append({
                    'name': line,
                    'qty': 1,
                    'price': 0,
                    'raw_line': line,
                })

    logger.info("OCR extracted %d lines from %s", len(results), image_path)
    return results
