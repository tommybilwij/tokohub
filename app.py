"""Flask application for Stock Receipt Entry."""

import io
import csv
import os
import sys
import argparse
import logging
from datetime import date, datetime, timedelta
from pathlib import Path

from flask import Flask, render_template, request, jsonify, Response
from werkzeug.utils import secure_filename

# Resolve base directory (supports PyInstaller frozen builds)
if getattr(sys, 'frozen', False):
    _BASE_DIR = Path(sys._MEIPASS)
else:
    _BASE_DIR = Path(__file__).parent

from config import settings, save_to_envrc, reload_settings

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(
    __name__,
    template_folder=str(_BASE_DIR / 'templates'),
    static_folder=str(_BASE_DIR / 'static'),
)
app.config['UPLOAD_FOLDER'] = str(settings.upload_folder)
app.config['MAX_CONTENT_LENGTH'] = settings.max_content_length

os.makedirs(settings.upload_folder, exist_ok=True)

_lan_active: bool = False


def _allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in settings.allowed_extensions


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    return render_template('receipt_form.html')


@app.route('/receipt/new')
def receipt_new():
    return render_template('receipt_form.html')


@app.route('/aliases')
def aliases_page():
    from services.alias_service import list_aliases
    page = request.args.get('page', 1, type=int)
    rows, total = list_aliases(page=page)
    return render_template('aliases.html', aliases=rows, total=total, page=page)


@app.route('/history')
def history_page():
    from services.po_service import get_po_history
    page = request.args.get('page', 1, type=int)
    rows, total = get_po_history(page=page)
    return render_template('history.html', orders=rows, total=total, page=page)


@app.route('/scanner')
def scanner_page():
    return render_template('scanner.html')


@app.route('/sales-history')
def sales_history_page():
    return render_template('sales_history.html')


@app.route('/settings')
def settings_page():
    from services.lan_auth import get_local_ip
    return render_template('settings.html',
                           lan_mode=_lan_active,
                           local_ip=get_local_ip(),
                           server_port=settings.server_port)


# ---------------------------------------------------------------------------
# API: Settings (read / write)
# ---------------------------------------------------------------------------

def _mask(value: str, visible: int = 4) -> str:
    """Mask a secret, showing only the last `visible` chars."""
    if not value or len(value) <= visible:
        return value
    return '*' * (len(value) - visible) + value[-visible:]


@app.route('/api/settings')
def api_settings_get():
    from config import settings as _s
    return jsonify({
        'db': {
            'host': _s.db.host,
            'port': _s.db.port,
            'user': _s.db.user,
            'password': _mask(_s.db.password),
            'name': _s.db.name,
            'pool_size': _s.db.pool_size,
        },
        'openai': {
            'api_base': _s.openai.api_base,
            'api_key': _mask(_s.openai.api_key),
            'deployment_id': _s.openai.deployment_id,
            'api_version': _s.openai.api_version,
        },
        'fuzzy_cache_ttl': _s.fuzzy_cache_ttl,
        'fuzzy_top_n': _s.fuzzy_top_n,
        'fuzzy_min_score': _s.fuzzy_min_score,
        'server_port': _s.server_port,
        'server_host': _s.server_host,
        'lan_mode': _s.lan_mode,
    })


@app.route('/api/settings', methods=['POST'])
def api_settings_post():
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400

    # Strip out masked password fields (user didn't change them)
    if 'db' in data and 'password' in data['db']:
        if data['db']['password'] == '' or '*' in data['db']['password']:
            del data['db']['password']
    if 'openai' in data and 'api_key' in data['openai']:
        if data['openai']['api_key'] == '' or '*' in data['openai']['api_key']:
            del data['openai']['api_key']

    try:
        save_to_envrc(data)
        return jsonify({'ok': True})
    except Exception as e:
        logger.exception("Failed to save settings")
        return jsonify({'error': str(e)}), 500


@app.route('/api/restart', methods=['POST'])
def api_restart():
    """Restart the server process. Works in both dev and Tauri sidecar mode."""
    import signal
    import threading
    from werkzeug.serving import is_running_from_reloader

    def _restart():
        import time
        time.sleep(0.5)  # let the response flush
        if is_running_from_reloader():
            # In debug mode: kill the parent reloader, then execv replaces this child
            try:
                os.kill(os.getppid(), signal.SIGTERM)
            except ProcessLookupError:
                pass
        os.execv(sys.executable, [sys.executable] + sys.argv)

    threading.Thread(target=_restart, daemon=True).start()
    return jsonify({'ok': True})


# ---------------------------------------------------------------------------
# API: Health check (used by Tauri to detect Flask readiness)
# ---------------------------------------------------------------------------

@app.route('/health')
def health():
    return jsonify({'status': 'ok'})


@app.route('/api/lan/status')
def api_lan_status():
    from services.lan_auth import get_local_ip
    ip = get_local_ip()
    return jsonify({
        'lan_mode': _lan_active,
        'local_ip': ip,
        'port': settings.server_port,
        'url': f'http://{ip}:{settings.server_port}' if _lan_active else '',
    })


# ---------------------------------------------------------------------------
# API: Stock search
# ---------------------------------------------------------------------------

@app.route('/api/stock/balance/<artno>')
def api_stock_balance(artno):
    from services.db import execute_query
    rows = execute_query(
        "SELECT warehouseid, curqty FROM stlastbal WHERE artno = %s",
        (artno,)
    )
    return jsonify(rows)


@app.route('/api/stock/search')
def api_stock_search():
    query = request.args.get('q', '').strip()
    if not query:
        return jsonify([])
    top_n = request.args.get('limit', None, type=int)
    min_score = request.args.get('min_score', None, type=int)
    score_against = request.args.get('score_against', '').strip() or None
    from services.stock_search import search_stock
    results = search_stock(query, top_n=top_n, min_score=min_score, score_against=score_against)
    return jsonify(results)


# ---------------------------------------------------------------------------
# API: Vendors
# ---------------------------------------------------------------------------

@app.route('/api/vendors')
def api_vendors():
    from services.db import execute_query
    rows = execute_query(
        "SELECT id, name, address, city, phone FROM vendor WHERE isactive = 1 ORDER BY name"
    )
    return jsonify(rows)


@app.route('/api/users')
def api_users():
    from services.db import execute_query
    rows = execute_query(
        "SELECT nouser, usrname FROM myposse_users.users ORDER BY nouser"
    )
    return jsonify(rows)


# ---------------------------------------------------------------------------
# Receipt upload: Photo OCR
# ---------------------------------------------------------------------------

@app.route('/receipt/upload-photo', methods=['POST'])
def upload_photo():
    if 'photo' not in request.files:
        return jsonify({'error': 'No photo uploaded'}), 400

    file = request.files['photo']
    if file.filename == '' or not _allowed_file(file.filename):
        return jsonify({'error': 'Invalid file type. Use PNG or JPG.'}), 400

    filename = secure_filename(file.filename)
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    file.save(filepath)

    try:
        from services.ocr import extract_lines
        items = extract_lines(filepath)
        return jsonify({'items': items})
    except Exception as e:
        logger.exception("OCR failed")
        return jsonify({'error': f'OCR processing failed: {e}'}), 500
    finally:
        if os.path.exists(filepath):
            os.remove(filepath)


# ---------------------------------------------------------------------------
# Receipt upload: CSV/Excel
# ---------------------------------------------------------------------------

@app.route('/receipt/upload-csv', methods=['POST'])
def upload_csv():
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400

    file = request.files['file']
    if file.filename == '' or not _allowed_file(file.filename):
        return jsonify({'error': 'Invalid file type. Use CSV or XLSX.'}), 400

    filename = secure_filename(file.filename)
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    file.save(filepath)

    try:
        ext = filename.rsplit('.', 1)[1].lower()
        if ext == 'csv':
            from services.csv_import import parse_csv
            items = parse_csv(file_path=filepath)
        else:
            from services.csv_import import parse_excel
            items = parse_excel(file_path=filepath)
        return jsonify({'items': items})
    except Exception as e:
        logger.exception("CSV/Excel parsing failed")
        return jsonify({'error': f'File parsing failed: {e}'}), 500
    finally:
        if os.path.exists(filepath):
            os.remove(filepath)


# ---------------------------------------------------------------------------
# Receipt matching
# ---------------------------------------------------------------------------

@app.route('/receipt/match', methods=['POST'])
def match_items():
    data = request.get_json()
    if not data or 'items' not in data:
        return jsonify({'error': 'No items provided'}), 400

    from services.stock_search import search_stock
    results = []
    for item in data['items']:
        name = item.get('name', '').strip()
        barcode = item.get('barcode', '').strip()
        if not name and not barcode:
            continue

        matches = []

        # Priority 1: Try barcode match first
        if barcode:
            matches = search_stock(barcode)
            # Only keep if barcode actually matched
            if matches and matches[0].get('match_type') != 'barcode':
                matches = []

        # Priority 2: Fall back to name (fuzzy) match
        if not matches and name:
            matches = search_stock(name)

        status = 'unmatched'
        if matches:
            if matches[0]['match_type'] in ('alias', 'barcode'):
                status = 'auto'
            elif matches[0]['score'] >= 85:
                status = 'auto'
            else:
                status = 'review'

        results.append({
            'name': name,
            'qty': item.get('qty', 1),
            'price': item.get('price', 0),
            'status': status,
            'matches': matches,
        })

    return jsonify({'results': results})


# ---------------------------------------------------------------------------
# Save alias
# ---------------------------------------------------------------------------

@app.route('/receipt/save-alias', methods=['POST'])
def save_alias():
    data = request.get_json()
    alias_name = data.get('alias_name', '').strip()
    artno = data.get('artno', '').strip()
    userid = data.get('userid', '').strip() or 'RECEIPT_APP'

    if not alias_name or not artno:
        return jsonify({'error': 'alias_name and artno are required'}), 400

    from services.alias_service import save_alias as _save
    success = _save(alias_name, artno, created_by=userid)
    if success:
        return jsonify({'ok': True})
    return jsonify({'ok': False, 'error': 'Alias already exists'}), 409


# ---------------------------------------------------------------------------
# Delete alias
# ---------------------------------------------------------------------------

@app.route('/receipt/delete-alias', methods=['POST'])
def delete_alias():
    data = request.get_json()
    alias_id = data.get('id')
    if not alias_id:
        return jsonify({'error': 'id is required'}), 400

    from services.alias_service import delete_alias as _delete
    _delete(alias_id)
    return jsonify({'ok': True})


# ---------------------------------------------------------------------------
# PO Preview & Commit
# ---------------------------------------------------------------------------

@app.route('/receipt/preview', methods=['POST'])
def preview_po():
    data = request.get_json()
    supplier_id = data.get('supplier_id', '').strip()
    items = data.get('items', [])
    order_date_str = data.get('order_date')

    if not supplier_id or not items:
        return jsonify({'error': 'supplier_id and items are required'}), 400

    order_date = date.fromisoformat(order_date_str) if order_date_str else date.today()

    shipping_cost = data.get('shipping_cost', 0)

    try:
        from services.po_service import preview_po as _preview
        result = _preview(supplier_id, items, order_date, shipping_cost=shipping_cost)
        return jsonify(result)
    except Exception as e:
        logger.exception("PO preview failed")
        return jsonify({'error': str(e)}), 500


@app.route('/receipt/commit', methods=['POST'])
def commit_po():
    data = request.get_json()
    supplier_id = data.get('supplier_id', '').strip()
    userid = data.get('userid', '').strip()
    items = data.get('items', [])
    order_date_str = data.get('order_date')

    if not supplier_id or not items or not userid:
        return jsonify({'error': 'supplier_id, userid, and items are required'}), 400

    order_date = date.fromisoformat(order_date_str) if order_date_str else date.today()

    shipping_cost = data.get('shipping_cost', 0)

    try:
        from services.po_service import commit_po as _commit
        result = _commit(supplier_id, items, order_date, userid=userid, shipping_cost=shipping_cost)
        return jsonify(result)
    except Exception as e:
        logger.exception("PO commit failed")
        return jsonify({'error': str(e)}), 500


# ---------------------------------------------------------------------------
# API: Sales History
# ---------------------------------------------------------------------------

_KASSA_IDS = ('002', '003', '004')


def _parse_sales_range():
    """Parse from/to, accepting date or datetime-local (YYYY-MM-DDTHH:MM)."""
    raw_from = request.args.get('from', '').strip().replace('T', ' ')
    raw_to = request.args.get('to', '').strip().replace('T', ' ')
    if not raw_from or not raw_to:
        return None, None
    if len(raw_from) == 10:
        raw_from += ' 00:00:00'
    elif len(raw_from) == 16:
        raw_from += ':00'
    if len(raw_to) == 10:
        raw_to += ' 23:59:59'
    elif len(raw_to) == 16:
        raw_to += ':59'
    return raw_from, raw_to


def _sl_table_names(dt_from, dt_to):
    """Return list of existing sl* table names covering the date range."""
    d_from = datetime.strptime(dt_from[:10], '%Y-%m-%d').date()
    d_to = datetime.strptime(dt_to[:10], '%Y-%m-%d').date()

    from services.db import execute_query
    candidates = []
    d = d_from
    while d <= d_to:
        prefix = d.strftime('%y%m%d')
        for k in _KASSA_IDS:
            candidates.append(f'sl{prefix}{k}')
        d += timedelta(days=1)

    if not candidates:
        return []

    placeholders = ','.join(['%s'] * len(candidates))
    rows = execute_query(
        f"SELECT TABLE_NAME FROM information_schema.TABLES "
        f"WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ({placeholders})",
        tuple(candidates)
    )
    return [r['TABLE_NAME'] for r in rows]


def _query_sales(dt_from, dt_to):
    """Query sl* tables for sales in the given datetime range."""
    tables = _sl_table_names(dt_from, dt_to)
    if not tables:
        return []

    unions = ' UNION ALL '.join(
        f"SELECT artno, transtime, qty, unitprc, netamount FROM `{t}`"
        for t in tables
    )
    sql = (
        f"SELECT s.artno, st.artname, st.artpabrik AS barcode, s.unitprc AS hjual, "
        f"SUM(s.qty) AS total_qty, SUM(s.netamount) AS total_amount "
        f"FROM ({unions}) s "
        f"JOIN stock st ON st.artno = s.artno "
        f"WHERE s.transtime BETWEEN %s AND %s "
        f"GROUP BY s.artno, st.artname, st.artpabrik, s.unitprc "
        f"ORDER BY total_amount DESC"
    )

    from services.db import execute_query
    return execute_query(sql, (dt_from, dt_to))


@app.route('/api/sales/history')
def api_sales_history():
    dt_from, dt_to = _parse_sales_range()
    if not dt_from:
        return jsonify([])

    rows = _query_sales(dt_from, dt_to)
    for r in rows:
        for k in ('hjual', 'total_qty', 'total_amount'):
            if r.get(k) is not None:
                r[k] = float(r[k])
    return jsonify(rows)


@app.route('/api/sales/export')
def api_sales_export():
    dt_from, dt_to = _parse_sales_range()
    if not dt_from:
        return jsonify({'error': 'from and to are required'}), 400

    rows = _query_sales(dt_from, dt_to)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(['Artno', 'Nama Barang', 'Barcode', 'Harga Jual', 'Qty', 'Total'])
    for r in rows:
        writer.writerow([
            r.get('artno', ''),
            r.get('artname', ''),
            r.get('barcode', ''),
            r.get('hjual', 0),
            r.get('total_qty', 0),
            r.get('total_amount', 0),
        ])

    output = buf.getvalue()
    f = request.args.get('from', '').replace('T', '_').replace(':', '')
    t = request.args.get('to', '').replace('T', '_').replace(':', '')
    filename = f'penjualan_{f}_{t}.csv'
    return Response(
        output,
        mimetype='text/csv',
        headers={'Content-Disposition': f'attachment; filename={filename}'}
    )


# ---------------------------------------------------------------------------
# PO Detail (JSON)
# ---------------------------------------------------------------------------

@app.route('/api/po/<po_number>')
def api_po_detail(po_number):
    from services.po_service import get_po_detail
    detail = get_po_detail(po_number)
    if not detail:
        return jsonify({'error': 'PO not found'}), 404
    return jsonify(detail)


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

def _ensure_schema():
    """Create stock_alias table if it doesn't exist."""
    try:
        from services.db import execute_modify
        schema_path = _BASE_DIR / 'schema' / 'stock_alias.sql'
        with open(schema_path) as f:
            sql = f.read()
        execute_modify(sql)
        logger.info("stock_alias table ensured")
    except Exception as e:
        logger.warning("Could not create stock_alias table (may already exist): %s", e)


def _parse_args():
    parser = argparse.ArgumentParser(description='Stock Entry Server')
    parser.add_argument('--port', type=int, default=settings.server_port)
    parser.add_argument('--host', type=str, default=settings.server_host)
    parser.add_argument('--lan', action='store_true', default=settings.lan_mode)
    return parser.parse_args()


def main():
    global _lan_active

    args = _parse_args()
    _ensure_schema()

    host = args.host
    port = args.port

    # LAN mode: bind 0.0.0.0 and restrict to private network IPs
    if args.lan:
        host = '0.0.0.0'
        from services.lan_auth import setup_lan_auth, get_local_ip
        setup_lan_auth(app)
        _lan_active = True
        logger.info("LAN mode enabled — access from: http://%s:%d",
                     get_local_ip(), port)

    # When running as frozen PyInstaller binary, disable debug & reloader
    is_frozen = getattr(sys, 'frozen', False)
    use_debug = not is_frozen

    ssl_context = None
    if not is_frozen:
        try:
            from services.ssl import ensure_ssl_cert
            cert_file, key_file = ensure_ssl_cert()
            ssl_context = (cert_file, key_file)
        except Exception:
            logger.info("SSL not available, running HTTP only")

    app.run(host=host, port=port, debug=use_debug, ssl_context=ssl_context)


if __name__ == '__main__':
    main()
