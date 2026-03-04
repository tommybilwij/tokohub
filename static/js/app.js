/**
 * Stock Entry App - Frontend Logic
 * Vanilla JS, no build step.
 */

(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------
  const UNIT_OPTIONS = ['CTN','BOX','BAL','DUS','PAK','LSN','KTK','RTG','ZAK','GONI','SAK','KLG','KRAT','PPN','TOP','PAIL','GROS','GROSS','KRT','Pcs'];

  const state = {
    items: [],       // [{name, barcode, qtyBesar, qtyKecil, satuanBsr, packing, priceBsr, priceTotal, priceKcl, status, matches, selectedArtno}]
    vendors: [],
    currentReviewIdx: null,
  };

  // -----------------------------------------------------------------------
  // DOM references
  // -----------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    userSelect:      $('#userSelect'),
    vendorSelect:    $('#vendorSelect'),
    orderDate:       $('#orderDate'),
    itemNameInput:   $('#itemNameInput'),
    btnAddItem:      $('#btnAddItem'),
    shippingCostInput: $('#shippingCostInput'),
    searchResults:   $('#searchResults'),
    itemTableBody:   $('#itemTableBody'),
    itemCount:       $('#itemCount'),
    emptyRow:        $('#emptyRow'),
    btnPreviewPO:    $('#btnPreviewPO'),
    btnClearAll:     $('#btnClearAll'),
    btnUploadPhoto:  $('#btnUploadPhoto'),
    btnUploadCSV:    $('#btnUploadCSV'),
    photoInput:      $('#photoInput'),
    csvInput:        $('#csvInput'),
    ocrStatus:       $('#ocrStatus'),
    // Modals
    matchModal:      $('#matchModal'),
    matchOrigName:   $('#matchOrigName'),
    matchCandidates: $('#matchCandidates'),
    matchFilter:     $('#matchFilter'),
    chkSaveAlias:    $('#chkSaveAlias'),
    poPreviewModal:  $('#poPreviewModal'),
    poSupplierName:  $('#poSupplierName'),
    poDate:          $('#poDate'),
    poGrandTotal:    $('#poGrandTotal'),
    poPreviewBody:   $('#poPreviewBody'),
    btnCommitPO:     $('#btnCommitPO'),
    poSuccessModal:  $('#poSuccessModal'),
    successPONumber: $('#successPONumber'),
    successTotal:    $('#successTotal'),
    successLineCount:$('#successLineCount'),
    btnNewReceipt:   $('#btnNewReceipt'),
  };

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------
  function formatNumber(n) {
    const num = Number(n);
    if (isNaN(num)) return '0';
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function parsePrice(str) {
    return parseFloat(String(str).replace(/,/g, '').replace(/[^0-9.\-]/g, '')) || 0;
  }

  /** Truncate (floor) a number to 2 decimal places — no rounding up. */
  function trunc2(n) {
    return Math.floor(n * 100) / 100;
  }

  function computeQty(item) {
    const big = item.qtyBesar || 0;
    const small = item.qtyKecil || 0;
    const pack = item.packing || 1;
    if (big && small) return big + (small / pack);
    if (small) return small / pack;
    return big;
  }

  /**
   * Calculate net purchase price after cascading discounts and tax.
   * Mirrors the backend calculation in po_service.preview_po().
   */
  function calcNetPrice(hbelibsr, pctdisc1, pctdisc2, pctdisc3, pctppn) {
    const d1 = hbelibsr * (pctdisc1 || 0) / 100;
    const afterD1 = hbelibsr - d1;
    const d2 = afterD1 * (pctdisc2 || 0) / 100;
    const afterD2 = afterD1 - d2;
    const d3 = afterD2 * (pctdisc3 || 0) / 100;
    const netto = afterD2 - d3;
    const ppnAmt = netto * (pctppn || 0) / 100;
    return { d1, d2, d3, ppnAmt, netto, final: netto + ppnAmt };
  }

  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // -----------------------------------------------------------------------
  // State Persistence (localStorage)
  // -----------------------------------------------------------------------
  const STORAGE_KEY = 'stockEntry_draft';

  function _saveState() {
    try {
      const draft = {
        items: state.items,
        header: {
          user: dom.userSelect ? dom.userSelect.value : '',
          vendor: dom.vendorSelect ? dom.vendorSelect.value : '',
          orderDate: dom.orderDate ? dom.orderDate.value : '',
          shippingCost: dom.shippingCostInput ? dom.shippingCostInput.value : '',
        },
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    } catch (e) {
      // Silently ignore quota errors
    }
  }

  const _saveStateDebounced = debounce(_saveState, 300);

  function _restoreState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const draft = JSON.parse(raw);
      if (!draft || !Array.isArray(draft.items) || draft.items.length === 0) return false;

      // Clean up values (old data may have NaN or "0.0000" strings)
      draft.items.forEach(item => {
        item.disc1 = parseFloat(item.disc1) || null;
        item.disc2 = parseFloat(item.disc2) || null;
        item.disc3 = parseFloat(item.disc3) || null;
        item.ppn = parseFloat(item.ppn) || null;
        // Sanitize hjual — NaN from old buggy auto-adjust
        ['hjual1','hjual2','hjual3','hjual4','hjual5'].forEach(f => {
          if (item[f] != null && isNaN(item[f])) item[f] = null;
        });
        // Backfill from match data for legacy items
        if (item.status === 'auto' && item.matches && item.matches.length) {
          const m = item.matches[0];
          // Always backfill hjual from DB match if item has no values
          if (!parseFloat(item.hjual1) && !parseFloat(item.hjual2) && !parseFloat(item.hjual3) && !parseFloat(item.hjual4) && !parseFloat(item.hjual5)) {
            item.hjual1 = parseFloat(m.hjual) || null;
            item.hjual2 = parseFloat(m.hjual2) || null;
            item.hjual3 = parseFloat(m.hjual3) || null;
            item.hjual4 = parseFloat(m.hjual4) || null;
            item.hjual5 = parseFloat(m.hjual5) || null;
            console.log('[backfill hjual]', item.artname, item.hjual1, item.hjual2, item.hjual3);
          }
          // Backfill bundling from DB if not set
          const bundlings = m._bundlings || [];
          [1, 2].forEach((t, i) => {
            const b = item[`bundling${t}`];
            const db = bundlings[i];
            if (db && !b.enabled) {
              b.enabled = true;
              b.minQty = db.qty || 0;
              b.hjual1 = parseFloat(db.hjual1) || null;
              b.hjual2 = parseFloat(db.hjual2) || null;
              b.hjual3 = parseFloat(db.hjual3) || null;
              b.hjual4 = parseFloat(db.hjual4) || null;
              b.hjual5 = parseFloat(db.hjual5) || null;
            }
          });
          // Backfill auto-adjust refs
          if (item._refNettoPcs == null) {
            const dbBeli = m.hbelibsr || 0;
            const dbNet = calcNetPrice(dbBeli, parseFloat(m.pctdisc1)||0, parseFloat(m.pctdisc2)||0, parseFloat(m.pctdisc3)||0, parseFloat(m.pctppn)||0);
            const dbPacking = parseInt(m.packing) || 1;
            item._refNettoPcs = dbNet.final / dbPacking;
          }
          if (!item._refHjual) {
            item._refHjual = {
              hjual1: m.hjual || null, hjual2: m.hjual2 || null,
              hjual3: m.hjual3 || null, hjual4: m.hjual4 || null, hjual5: m.hjual5 || null
            };
          }
        }
      });

      state.items = draft.items;

      // Restore header fields after dropdowns are populated
      if (draft.header) {
        if (draft.header.user && dom.userSelect) dom.userSelect.value = draft.header.user;
        if (draft.header.vendor && dom.vendorSelect) dom.vendorSelect.value = draft.header.vendor;
        if (draft.header.orderDate && dom.orderDate) dom.orderDate.value = draft.header.orderDate;
        if (draft.header.shippingCost && dom.shippingCostInput) {
          const sc = parsePrice(draft.header.shippingCost);
          dom.shippingCostInput.value = sc ? formatNumber(sc) : '0.00';
        }
      }

      return true;
    } catch (e) {
      return false;
    }
  }

  function _clearSavedState() {
    localStorage.removeItem(STORAGE_KEY);
  }

  async function api(url, opts = {}) {
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function requireHeaderFields() {
    if (!dom.userSelect.value) { alert('Pilih user terlebih dahulu.'); dom.userSelect.focus(); return false; }
    if (!dom.vendorSelect.value) { alert('Pilih supplier terlebih dahulu.'); dom.vendorSelect.focus(); return false; }
    if (!dom.orderDate.value) { alert('Isi tanggal terlebih dahulu.'); dom.orderDate.focus(); return false; }
    return true;
  }

  function showSpinner() {
    const el = document.createElement('div');
    el.className = 'spinner-overlay';
    el.id = 'globalSpinner';
    el.innerHTML = '<div class="spinner-border text-success spinner-lg"></div>';
    document.body.appendChild(el);
  }

  function hideSpinner() {
    const el = $('#globalSpinner');
    if (el) el.remove();
  }

  // Show a Bootstrap toast notification
  function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const iconMap = { success: 'check-circle-fill', danger: 'exclamation-triangle-fill', warning: 'exclamation-circle-fill', info: 'info-circle-fill' };
    const icon = iconMap[type] || iconMap.info;
    const id = 'toast-' + Date.now();
    const html = `
      <div id="${id}" class="toast align-items-center text-bg-${type} border-0" role="alert">
        <div class="d-flex">
          <div class="toast-body"><i class="bi bi-${icon} me-1"></i> ${message}</div>
          <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
        </div>
      </div>`;
    container.insertAdjacentHTML('beforeend', html);
    const toastEl = document.getElementById(id);
    const bsToast = new bootstrap.Toast(toastEl, { delay: 4000 });
    bsToast.show();
    toastEl.addEventListener('hidden.bs.toast', () => toastEl.remove());
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------
  async function init() {
    // Guard: only run on receipt form page
    if (!dom.vendorSelect) return;

    // Set today's date as default
    if (dom.orderDate) {
      dom.orderDate.value = new Date().toISOString().slice(0, 10);
    }

    // Load dropdowns first, then restore saved state
    await Promise.all([loadUsers(), loadVendors()]);
    bindEvents();

    // Restore draft from localStorage (if any)
    if (_restoreState()) {
      renderItemTable();
    }
  }

  async function loadUsers() {
    try {
      const users = await api('/api/users');
      users.forEach((u) => {
        const opt = document.createElement('option');
        opt.value = u.nouser;
        opt.textContent = u.usrname || u.nouser;
        dom.userSelect.appendChild(opt);
      });
    } catch (e) {
      console.error('Failed to load users:', e);
    }
  }

  async function loadVendors() {
    try {
      state.vendors = await api('/api/vendors');
      state.vendors.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = `${v.id} - ${v.name || ''}`;
        dom.vendorSelect.appendChild(opt);
      });
    } catch (e) {
      console.error('Failed to load vendors:', e);
    }
  }

  // -----------------------------------------------------------------------
  // Event Binding
  // -----------------------------------------------------------------------
  function bindEvents() {
    // Add item (button + Enter key)
    dom.btnAddItem.addEventListener('click', addItemFromInput);
    dom.itemNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addItemFromInput();
      }
    });

    // Live search
    dom.itemNameInput.addEventListener('input', debounce(onLiveSearch, 300));
    document.addEventListener('click', (e) => {
      if (!dom.searchResults.contains(e.target) && e.target !== dom.itemNameInput) {
        dom.searchResults.classList.add('d-none');
      }
    });

    // Action buttons
    dom.btnPreviewPO.addEventListener('click', previewPO);
    dom.btnClearAll.addEventListener('click', clearAllItems);

    // Header fields — persist on change
    dom.userSelect.addEventListener('change', _saveStateDebounced);
    dom.vendorSelect.addEventListener('change', _saveStateDebounced);
    dom.orderDate.addEventListener('change', _saveStateDebounced);

    // Shipping cost: format on blur + recalc all items
    dom.shippingCostInput.addEventListener('change', () => {
      const val = parsePrice(dom.shippingCostInput.value);
      dom.shippingCostInput.value = val ? formatNumber(val) : '0.00';
      state.items.forEach((_, idx) => _updateComputedPrices(idx));
      _saveStateDebounced();
    });

    // File uploads
    dom.btnUploadPhoto.addEventListener('click', uploadPhoto);
    dom.btnUploadCSV.addEventListener('click', uploadCSV);

    // PO commit
    dom.btnCommitPO.addEventListener('click', commitPO);

    // New receipt after success
    dom.btnNewReceipt.addEventListener('click', () => {
      bootstrap.Modal.getInstance(dom.poSuccessModal).hide();
      clearAllItems();
    });

    // --- Keyboard shortcuts ---
    document.addEventListener('keydown', (e) => {
      // Escape → collapse any open detail panel
      if (e.key === 'Escape' && !document.querySelector('.modal.show')) {
        document.querySelectorAll('#itemTable .item-main.has-detail-open').forEach(row => {
          row.click();
        });
      }
    });

    // Enter on table inputs → move to next input in same row
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const target = e.target;
      if (!target.matches('#itemTable .item-main input, #itemTable .item-main select')) return;
      e.preventDefault();
      const row = target.closest('tr');
      const inputs = Array.from(row.querySelectorAll('input, select'));
      const idx = inputs.indexOf(target);
      if (idx < inputs.length - 1) {
        inputs[idx + 1].focus();
        if (inputs[idx + 1].select) inputs[idx + 1].select();
      }
    });
  }

  // -----------------------------------------------------------------------
  // Live Search
  // -----------------------------------------------------------------------
  async function onLiveSearch() {
    const query = dom.itemNameInput.value.trim();
    if (query.length < 2) {
      dom.searchResults.classList.add('d-none');
      return;
    }

    try {
      const results = await api(`/api/stock/search?q=${encodeURIComponent(query)}`);
      renderSearchResults(results);
    } catch (e) {
      console.error('Search error:', e);
    }
  }

  function renderSearchResults(results) {
    dom.searchResults.innerHTML = '';
    if (!results.length) {
      dom.searchResults.classList.add('d-none');
      return;
    }

    results.forEach((item) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'list-group-item list-group-item-action';

      const scoreClass = item.score >= 80 ? 'score-high' : item.score >= 60 ? 'score-mid' : 'score-low';
      el.innerHTML = `
        <div class="d-flex justify-content-between">
          <span>${item.artname || ''}</span>
          <span class="match-score ${scoreClass}">${item.score}%</span>
        </div>
        <small class="text-muted">${item.artno} | ${item.artpabrik || ''}</small>
      `;

      el.addEventListener('click', () => {
        if (!requireHeaderFields()) return;
        dom.searchResults.classList.add('d-none');
        addItem(item.artname, item.artpabrik || '', 1, 0, item.satbesar || 'CTN', item.packing || 1, item.hbelibsr || 0, 'auto',  [item], item.artno,
                null, null, null, null);
        dom.itemNameInput.value = '';
        dom.itemNameInput.focus();
      });

      dom.searchResults.appendChild(el);
    });

    dom.searchResults.classList.remove('d-none');
  }

  // -----------------------------------------------------------------------
  // Item Management
  // -----------------------------------------------------------------------
  async function addItemFromInput() {
    if (!requireHeaderFields()) return;

    const name = dom.itemNameInput.value.trim();
    if (!name) return;

    addItem(name, '', 1, 0, 'CTN', 1, 0);
    dom.itemNameInput.value = '';
    dom.itemNameInput.focus();
    dom.searchResults.classList.add('d-none');

    // Auto-match (alias/barcode check)
    try { await _doMatch(); } catch (e) { /* silent */ }
  }

  function addItem(name, barcode, qtyBesar, qtyKecil, satuanBsr, packing, priceTotal, status, matches, selectedArtno, disc1, disc2, disc3, ppn) {
    const pt = priceTotal || 0;
    const qb = qtyBesar ?? 1;
    const pk = packing || 1;
    const pb = qb ? pt / qb : pt;
    state.items.push({
      name,
      barcode: barcode || '',
      qtyBesar: qb,
      qtyKecil: qtyKecil ?? 0,
      satuanBsr: satuanBsr || 'CTN',
      packing: pk,
      priceBsr: pb,
      priceTotal: pt,
      priceKcl: pb / pk,
      status: status || 'unmatched',
      matches: matches || [],
      selectedArtno: selectedArtno || null,
      disc1: disc1 ?? null,
      disc2: disc2 ?? null,
      disc3: disc3 ?? null,
      ppn: ppn ?? null,
      hjual1: null,
      hjual2: null,
      hjual3: null,
      hjual4: null,
      hjual5: null,
      bundling1: { enabled: false, minQty: 0, hjual1: null, hjual3: null, hjual4: null, hjual5: null, hjual2: null },
      bundling2: { enabled: false, minQty: 0, hjual1: null, hjual3: null, hjual4: null, hjual5: null, hjual2: null },
      autoAdjustJual: false,
      _refNettoPcs: null,
      _refHjual: null,
      _saveAlias: false,
    });
    // Auto-fill hjual, bundling, and ref values from first match when auto-matched
    const added = state.items[state.items.length - 1];
    if (status === 'auto' && matches && matches.length) {
      const m = matches[0];
      added.hjual1 = parseFloat(m.hjual) || null;
      added.hjual2 = parseFloat(m.hjual2) || null;
      added.hjual3 = parseFloat(m.hjual3) || null;
      added.hjual4 = parseFloat(m.hjual4) || null;
      added.hjual5 = parseFloat(m.hjual5) || null;
      const bndl = m._bundlings || [];
      [1, 2].forEach((t, i) => {
        const b = added[`bundling${t}`];
        const db = bndl[i];
        if (db) {
          b.enabled = true;
          b.minQty = db.qty || 0;
          b.hjual1 = parseFloat(db.hjual1) || null;
          b.hjual2 = parseFloat(db.hjual2) || null;
          b.hjual3 = parseFloat(db.hjual3) || null;
          b.hjual4 = parseFloat(db.hjual4) || null;
          b.hjual5 = parseFloat(db.hjual5) || null;
        }
      });
      const dbBeli = parseFloat(m.hbelibsr) || 0;
      const dbNet = calcNetPrice(dbBeli, parseFloat(m.pctdisc1)||0, parseFloat(m.pctdisc2)||0, parseFloat(m.pctdisc3)||0, parseFloat(m.pctppn)||0);
      const dbPacking = parseInt(m.packing) || 1;
      added._refNettoPcs = dbNet.final / dbPacking;
      added._refHjual = { hjual1: added.hjual1, hjual2: added.hjual2, hjual3: added.hjual3, hjual4: added.hjual4, hjual5: added.hjual5 };
    }
    renderItemTable();
    showToast(`"${name}" ditambahkan`, 'success');
  }

  function removeItem(idx) {
    const name = state.items[idx]?.name || 'Item';
    state.items.splice(idx, 1);
    renderItemTable();
    showToast(`"${name}" dihapus`, 'info');
  }

  function clearAllItems() {
    if (state.items.length === 0) return;
    state.items = [];
    renderItemTable();
    showToast('Semua item dihapus', 'info');
  }

  // Render a jual price table (reusable for main + bundling tiers)
  // tier: null = main, 1 = bundling1, 2 = bundling2
  function _renderJualTable(idx, tier, values) {
    const t = tier == null ? 'main' : tier;
    const dis = tier != null && !values._enabled ? 'disabled' : '';
    const rows = [
      { label: 'Jual 1', field: 'hjual1' },
      { label: 'Jual 3', field: 'hjual3' },
      { label: 'Jual 4', field: 'hjual4' },
      { label: 'Jual 5', field: 'hjual5' },
      { label: 'Member', field: 'hjual2' },
    ];
    const rowsHTML = rows.map(r => {
      const val = values[r.field];
      return `<tr>
        <td class="jt-label">${r.label}</td>
        <td><input type="text" class="jual-input" data-idx="${idx}" data-tier="${t}" data-field="${r.field}"
                   value="${val != null ? formatNumber(val) : ''}" placeholder="—" inputmode="decimal" ${dis}></td>
        <td class="jt-pct"><input type="text" class="jual-pct-input" data-idx="${idx}" data-tier="${t}" data-field="${r.field}"
                   value="" placeholder="—" inputmode="decimal" ${dis}></td>
        <td class="jt-margin"><span class="jual-margin" data-idx="${idx}" data-tier="${t}" data-field="${r.field}">—</span></td>
      </tr>`;
    }).join('');
    return `<table class="jual-table"><thead><tr><th></th><th>Harga</th><th>Mrg%</th><th>Margin</th></tr></thead><tbody>${rowsHTML}</tbody></table>`;
  }

  // Render a bundling group (1 or 2) for the detail panel
  function _renderBundlingGroup(idx, tier, b, item) {
    const checked = b.enabled ? 'checked' : '';
    const disabled = b.enabled ? '' : 'disabled';
    const vals = { hjual1: b.hjual1, hjual2: b.hjual2, hjual3: b.hjual3, hjual4: b.hjual4, hjual5: b.hjual5, _enabled: b.enabled };
    const showBtns = b.enabled && item.status === 'auto' && item._refHjual;
    return `
      <div class="dp-bundling-section">
        <div class="dp-section-header">
          <label class="bundling-toggle">
            <input type="checkbox" class="form-check-input bundling-enable" data-idx="${idx}" data-tier="${tier}" ${checked}>
            Harga Jual (Bundling ${tier})
          </label>
          <span class="bundling-qty-wrap">Qty &ge;
            <input type="number" class="bundling-minqty" data-idx="${idx}" data-tier="${tier}"
                   value="${b.minQty || ''}" placeholder="0" min="1" step="0.01" ${disabled}> <span style="text-transform:none">Pcs</span>
          </span>
          ${showBtns ? `<span class="auto-adjust-group">
            <button type="button" class="auto-adjust-toggle btn-round-hundred" data-idx="${idx}" data-tier="${tier}" title="Bulatkan ke ratusan">
              <i class="bi bi-chevron-bar-up"></i> Bulatan 100
            </button>
            <button type="button" class="auto-adjust-toggle btn-auto-adjust-jual" data-idx="${idx}" data-tier="${tier}">
              <i class="bi bi-arrow-repeat"></i> Ikuti Margin
            </button>
          </span>` : ''}
        </div>
        <div class="bundling-fields${b.enabled ? '' : ' bundling-fields-disabled'}" data-idx="${idx}" data-tier="${tier}">
          ${_renderJualTable(idx, tier, vals)}
        </div>
      </div>`;
  }

  // Auto-adjust harga jual based on harga beli delta
  function _autoAdjustJual(idx, tier) {
    const item = state.items[idx];
    if (!item.matches || !item.matches.length) return;
    const m = item.matches[0];

    // Reference netto per pcs from STOK SAAT INI
    const dbBeli = parseFloat(m.hbelibsr) || 0;
    const dbNet = calcNetPrice(dbBeli, parseFloat(m.pctdisc1)||0, parseFloat(m.pctdisc2)||0, parseFloat(m.pctdisc3)||0, parseFloat(m.pctppn)||0);
    const dbPacking = parseInt(m.packing) || 1;
    const refNettoPcs = dbNet.final / dbPacking;
    if (!refNettoPcs) return;

    // Reference jual prices — use bundling ref if tier specified
    let refHjual;
    if (tier) {
      const bundlings = m._bundlings || [];
      const bIdx = parseInt(tier) - 1;
      const db = bundlings[bIdx];
      if (!db) return;
      refHjual = {
        hjual1: parseFloat(db.hjual1) || 0, hjual2: parseFloat(db.hjual2) || 0,
        hjual3: parseFloat(db.hjual3) || 0, hjual4: parseFloat(db.hjual4) || 0,
        hjual5: parseFloat(db.hjual5) || 0
      };
    } else {
      refHjual = {
        hjual1: parseFloat(m.hjual) || 0, hjual2: parseFloat(m.hjual2) || 0,
        hjual3: parseFloat(m.hjual3) || 0, hjual4: parseFloat(m.hjual4) || 0,
        hjual5: parseFloat(m.hjual5) || 0
      };
    }

    // Current netto per pcs (including shipping)
    const hbelibsr = item.priceBsr || 0;
    const net = calcNetPrice(hbelibsr, item.disc1, item.disc2, item.disc3, item.ppn);
    const totalShipping = parsePrice(dom.shippingCostInput.value);
    let shippingForItem = 0;
    if (totalShipping > 0) {
      const itemCount = state.items.length;
      shippingForItem = itemCount > 0 ? totalShipping / itemCount : 0;
    }
    const finalBsr = net.final + shippingForItem;
    const qtyKcl = item.packing || 1;
    const currentNettoPcs = qtyKcl > 0 ? finalBsr / qtyKcl : 0;
    if (!currentNettoPcs) return;

    // Target: main item or bundling tier
    const target = tier ? item[`bundling${tier}`] : item;
    const tierKey = tier || 'main';

    // Apply same absolute margin (rupiah) from reference to current netto
    ['hjual1','hjual2','hjual3','hjual4','hjual5'].forEach(f => {
      const refVal = refHjual[f];
      if (refVal > 0) {
        const margin = refVal - refNettoPcs;
        target[f] = currentNettoPcs + margin;
      }
    });
    // Update jual input values in DOM
    ['hjual1','hjual2','hjual3','hjual4','hjual5'].forEach(f => {
      const input = document.querySelector(`.jual-input[data-idx="${idx}"][data-tier="${tierKey}"][data-field="${f}"]`);
      if (input) input.value = (target[f] != null && !isNaN(target[f])) ? formatNumber(target[f]) : '';
    });
  }

  // Price recalculation helper (used by render and event handlers)
  function _recalcFromTotal(idx) {
    const item = state.items[idx];
    const qty = computeQty(item) || 1;
    item.priceBsr = qty ? item.priceTotal / qty : item.priceTotal;
    item.priceKcl = item.packing > 0 ? item.priceBsr / item.packing : 0;
    _updateDetailLabels(idx);
    _updateComputedPrices(idx);
    _saveStateDebounced();
  }

  /** Update all dynamic satuan/qty labels in the detail panel */
  function _updateDetailLabels(idx) {
    const item = state.items[idx];
    const sat = item.satuanBsr || 'Bsr';
    const qtyBsr = item.qtyBesar || 1;
    const detailRow = document.querySelector(`.item-detail[data-idx="${idx}"]`);
    if (!detailRow) return;
    // Update all /SatuanBsr unit labels
    detailRow.querySelectorAll('.dp-unit-bsr').forEach(el => { el.textContent = '/' + sat; });
    // Update qty besar display in header
    detailRow.querySelectorAll('.dp-qty-bsr').forEach(el => { el.textContent = qtyBsr; });
  }

  function _updateComputedPrices(idx) {
    const item = state.items[idx];
    const hbelibsr = item.priceBsr || 0;
    // Use packing (conversion factor, e.g. 20 pcs/CTN) for /Pcs display and margin calc
    const qtyKcl = item.packing || 0;
    const showPcs = qtyKcl > 0 && (item.qtyKecil || 0) > 0;
    const showBsr = (item.qtyBesar || 0) > 0;

    // H.Beli /Bsr and /Pcs
    const hbeliBsrEl = document.querySelector(`.hbeli-bsr[data-idx="${idx}"]`);
    const hbeliPcsEl = document.querySelector(`.hbeli-pcs[data-idx="${idx}"]`);
    if (hbeliBsrEl) hbeliBsrEl.textContent = (hbelibsr && showBsr) ? formatNumber(hbelibsr) : '—';
    if (hbeliPcsEl) hbeliPcsEl.textContent = (hbelibsr && showPcs) ? formatNumber(trunc2(hbelibsr / qtyKcl)) : '—';

    // Disc amounts — update per-unit and total amt inputs
    const qtyBsr = item.qtyBesar || 1;
    const net = calcNetPrice(hbelibsr, item.disc1, item.disc2, item.disc3, item.ppn);
    const amtMap = { disc1: net.d1, disc2: net.d2, disc3: net.d3, ppn: net.ppnAmt };
    ['disc1','disc2','disc3','ppn'].forEach(f => {
      const amtEl = document.querySelector(`.edit-disc-amt[data-idx="${idx}"][data-field="${f}"]`);
      if (amtEl && document.activeElement !== amtEl) amtEl.value = amtMap[f] ? formatNumber(amtMap[f]) : '';
      const totalEl = document.querySelector(`.edit-disc-total[data-idx="${idx}"][data-field="${f}"]`);
      if (totalEl && document.activeElement !== totalEl) totalEl.value = amtMap[f] ? formatNumber(amtMap[f] * qtyBsr) : '';
    });

    // Shipping cost divided equally per item
    const totalShipping = parsePrice(dom.shippingCostInput.value);
    let shippingForItem = 0;
    if (totalShipping > 0) {
      const itemCount = state.items.length;
      shippingForItem = itemCount > 0 ? totalShipping / itemCount : 0;
    }
    const shippingValEl = document.querySelector(`.bt-shipping-val[data-idx="${idx}"]`);
    if (shippingValEl) shippingValEl.textContent = shippingForItem ? formatNumber(shippingForItem) : '—';

    // Netto /Bsr and /Pcs (final = netto + ppn + shipping for this item)
    const finalBsr = net.final + shippingForItem;
    const nettoBsrEl = document.querySelector(`.netto-bsr[data-idx="${idx}"]`);
    const nettoPcsEl = document.querySelector(`.netto-pcs[data-idx="${idx}"]`);
    if (hbelibsr && showBsr) {
      if (nettoBsrEl) nettoBsrEl.textContent = formatNumber(finalBsr);
      if (nettoPcsEl) nettoPcsEl.textContent = showPcs ? formatNumber(finalBsr / qtyKcl) : '—';
    } else {
      if (nettoBsrEl) nettoBsrEl.textContent = '—';
      if (nettoPcsEl) nettoPcsEl.textContent = '—';
    }

    // Reference cost per pcs for markup calculations (always use packing, independent of qtyKecil)
    const nettoPcs = (hbelibsr && qtyKcl > 0) ? finalBsr / qtyKcl : 0;

    // Update jual markup% and margin for a given tier
    function updateJualRow(tier, field, hjualVal) {
      const pctEl = document.querySelector(`.jual-pct-input[data-idx="${idx}"][data-tier="${tier}"][data-field="${field}"]`);
      const mrgEl = document.querySelector(`.jual-margin[data-idx="${idx}"][data-tier="${tier}"][data-field="${field}"]`);
      if (!pctEl || !mrgEl) return;
      if (hjualVal == null || isNaN(hjualVal) || hjualVal <= 0 || !nettoPcs) {
        if (document.activeElement !== pctEl) pctEl.value = '';
        mrgEl.textContent = '—';
        const noMargin = nettoPcs > 0 && (hjualVal == null || isNaN(hjualVal) || hjualVal <= 0);
        pctEl.classList.toggle('negative', noMargin);
        mrgEl.classList.toggle('negative', noMargin);
        return;
      }
      const margin = hjualVal - nettoPcs;
      const pct = (margin / nettoPcs) * 100;
      const isNeg = margin < 0;
      if (document.activeElement !== pctEl) pctEl.value = pct.toFixed(1);
      mrgEl.textContent = isNeg ? `-${formatNumber(Math.abs(margin))}` : formatNumber(margin);
      pctEl.classList.toggle('negative', isNeg);
      mrgEl.classList.toggle('negative', isNeg);
    }

    // Main jual prices
    ['hjual1', 'hjual2', 'hjual3', 'hjual4', 'hjual5'].forEach(f => updateJualRow('main', f, item[f]));

    // Bundling tiers
    [1, 2].forEach(t => {
      const b = item[`bundling${t}`];
      ['hjual1', 'hjual2', 'hjual3', 'hjual4', 'hjual5'].forEach(f => updateJualRow(String(t), f, b[f]));
    });
  }

  // Render stock reference banner for the detail panel (read-only DB data)
  function _renderStockInfo(idx, item) {
    if (item.status !== 'auto' || !item.matches.length) return '';
    const m = item.matches[0];

    // Badge
    let typeBadge = '';
    if (m.match_type === 'alias') typeBadge = '<span class="badge bg-info">alias</span>';
    else if (m.match_type === 'barcode') typeBadge = '<span class="badge bg-primary">barcode</span>';
    else typeBadge = `<span class="badge bg-success">${m.score}%</span>`;

    const packNum = m.packing ? parseInt(m.packing) : '';
    const hbelikcl = m.hbelikcl || (m.hbelibsr && packNum ? trunc2(m.hbelibsr / packNum) : 0);

    // Disc pills (only non-zero — parseFloat to handle string "0.0000")
    const discItems = [];
    if (parseFloat(m.pctdisc1)) discItems.push({ label: 'D1', val: parseFloat(m.pctdisc1) });
    if (parseFloat(m.pctdisc2)) discItems.push({ label: 'D2', val: parseFloat(m.pctdisc2) });
    if (parseFloat(m.pctdisc3)) discItems.push({ label: 'D3', val: parseFloat(m.pctdisc3) });
    if (parseFloat(m.pctppn)) discItems.push({ label: 'PPN', val: parseFloat(m.pctppn) });
    const discHTML = discItems.length
      ? discItems.map(d => `<span class="dsi-disc">${d.label} <b>${d.val}%</b></span>`).join('')
      : '';

    // Netto
    const hasDiscOrPpn = parseFloat(m.pctdisc1) || parseFloat(m.pctdisc2) || parseFloat(m.pctdisc3) || parseFloat(m.pctppn);
    const netPrices = hasDiscOrPpn ? calcNetPrice(m.hbelibsr || 0, m.pctdisc1, m.pctdisc2, m.pctdisc3, m.pctppn) : null;

    // Netto per pcs for margin calc
    const dsiNettoPcs = netPrices && packNum ? netPrices.final / packNum
                      : (m.hbelibsr && packNum ? m.hbelibsr / packNum : 0);

    // Build price table rows: main + bundlings
    const bundlings = m._bundlings || [];
    const priceHeaders = ['Jual 1', 'Jual 3', 'Jual 4', 'Jual 5', 'Member'];
    const mainPrices = [m.hjual, m.hjual3, m.hjual4, m.hjual5, m.hjual2];
    const priceRows = [{ label: 'Satuan', prices: mainPrices, isMain: true }];
    bundlings.forEach(b => {
      priceRows.push({ label: `Bundling \u2265${b.qty}`, prices: [b.hjual1, b.hjual3, b.hjual4, b.hjual5, b.hjual2], isMain: false });
    });

    const numCols = priceHeaders.length + 1;
    const jualHeaderRow = `<tr class="dsi-jual-head-row"><th class="dsi-pt-tier"><span class="dsi-section-lbl">Tier</span></th>${priceHeaders.map(h => `<th>${h}</th>`).join('')}</tr>`;
    const jualBodyRows = priceRows.map(row => {
      const rowCls = row.isMain ? '' : ' class="dsi-pt-bundling"';
      const cells = row.prices.map(p => {
        const val = parseFloat(p) || 0;
        let marginHTML = '';
        if (val > 0 && dsiNettoPcs) {
          const mg = val - dsiNettoPcs;
          const isNeg = mg < 0;
          marginHTML = `<span class="dsi-pt-margin${isNeg ? ' negative' : ''}">${isNeg ? '-' : '+'}${formatNumber(Math.abs(mg))}</span>`;
        }
        const emptyCls = val ? '' : ' dsi-pt-empty';
        return `<td><span class="dsi-pt-val${emptyCls}">${val ? formatNumber(val) : '—'}</span>${marginHTML}</td>`;
      }).join('');
      return `<tr${rowCls}><td class="dsi-pt-tier">${row.label}</td>${cells}</tr>`;
    }).join('');

    return `
      <div class="dp-stock-info">
        <div class="dsi-header">
          <span class="dsi-title">STOK SAAT INI</span>
          <div class="dsi-header-left">
            ${typeBadge}
            <span class="dsi-artno">${m.artno}</span>
            <span class="dsi-artname">${m.artname || ''}</span>
          </div>
          <span class="dsi-packing">${packNum || '-'} ${m.satkecil || 'Pcs'} / ${m.satbesar || '-'}</span>
        </div>

        <div class="dsi-beli-header"><span class="dsi-section-lbl">Harga Beli</span></div>
        <div class="dsi-beli-block">
          <div class="dsi-beli-line">
            <span class="dsi-beli-label">Beli</span>
            <span class="dsi-val">${formatNumber(m.hbelibsr || 0)}</span><span class="dsi-unit">/${m.satbesar || 'Bsr'}</span>
            <span class="dsi-val dsi-val-sm">${formatNumber(hbelikcl)}</span><span class="dsi-unit">/${m.satkecil || 'Pcs'}</span>
          </div>
          ${discHTML ? `<div class="dsi-disc-pills">${discHTML}</div>` : ''}
          ${netPrices ? `<div class="dsi-netto-bar">
            <span class="dsi-lbl">Netto</span>
            <span class="dsi-netto-val">${formatNumber(netPrices.final)}</span><span class="dsi-unit">/${m.satbesar || 'Bsr'}</span>
            <span class="dsi-netto-val dsi-val-sm">${packNum ? formatNumber(netPrices.final / packNum) : '—'}</span><span class="dsi-unit">/${m.satkecil || 'Pcs'}</span>
          </div>` : ''}
        </div>

        <div class="dsi-jual-header"><span class="dsi-section-lbl">Harga Jual</span></div>
        <div class="dsi-sections dsi-jual-card">
          <table class="dsi-price-tbl dsi-jual-tbl">
            <tbody>
              ${jualHeaderRow}
              ${jualBodyRows}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function renderItemTable() {
    const tbody = dom.itemTableBody;
    tbody.innerHTML = '';

    if (state.items.length === 0) {
      tbody.innerHTML = `
        <tr><td colspan="8" class="text-center text-muted py-5">
          <i class="bi bi-inbox empty-state-icon"></i><br>
          <span class="mt-2 d-inline-block">Belum ada barang. Tambahkan dari panel kiri.</span>
        </td></tr>`;
      dom.itemCount.textContent = '0 item';
      dom.btnPreviewPO.disabled = true;
      dom.btnClearAll.disabled = true;
      _saveState();
      return;
    }

    state.items.forEach((item, idx) => {
      // --- Main row ---
      const tr = document.createElement('tr');
      tr.className = `item-main status-${item.status}`;
      tr.dataset.idx = idx;

      let matchHTML = '';
      if (item.status === 'auto' && item.matches.length) {
        const m = item.matches[0];
        let typeBadge = '';
        if (m.match_type === 'alias') typeBadge = '<span class="badge bg-info me-1">alias</span>';
        else if (m.match_type === 'barcode') typeBadge = '<span class="badge bg-primary me-1">barcode</span>';
        else typeBadge = `<span class="badge bg-success me-1">${m.score}%</span>`;

        matchHTML = `
          <button class="btn btn-sm btn-success btn-review" data-idx="${idx}" title="Klik untuk ganti">
            ${typeBadge}${m.artname || m.artno}
          </button>`;
      } else if (item.status === 'review') {
        matchHTML = `<button class="btn btn-sm btn-warning btn-review" data-idx="${idx}">
          <i class="bi bi-search"></i> Pilih
        </button>`;
      } else {
        matchHTML = `<button class="btn btn-sm btn-outline-danger btn-review" data-idx="${idx}">
          <i class="bi bi-search"></i> Pilih
        </button>`;
      }

      const unitOpts = UNIT_OPTIONS.map(u =>
        `<option value="${u}"${u === item.satuanBsr ? ' selected' : ''}>${u}</option>`
      ).join('');

      tr.innerHTML = `
        <td class="row-num">
          <span class="expand-toggle"><i class="bi bi-chevron-right"></i></span>
          ${idx + 1}
        </td>
        <td>
          <input type="text" class="form-control edit-name" data-idx="${idx}"
                 value="${item.name.replace(/"/g, '&quot;')}" title="${item.name.replace(/"/g, '&quot;')}">
        </td>
        <td>
          <input type="text" class="form-control edit-barcode" data-idx="${idx}"
                 value="${(item.barcode || '').replace(/"/g, '&quot;')}" placeholder="—" inputmode="numeric">
        </td>
        <td>
          <div class="d-flex gap-1 align-items-center">
            <div class="qty-stepper">
              <button type="button" class="qty-stepper-btn qtybsr-down" data-idx="${idx}"><i class="bi bi-dash"></i></button>
              <input type="number" class="form-control edit-qty-besar" data-idx="${idx}"
                     value="${item.qtyBesar}" min="0" step="0.01">
              <button type="button" class="qty-stepper-btn qtybsr-up" data-idx="${idx}"><i class="bi bi-plus"></i></button>
            </div>
            <select class="form-select edit-satuan-bsr w-fixed-72" data-idx="${idx}">
              ${unitOpts}
            </select>
          </div>
        </td>
        <td>
          <div class="qty-stepper">
            <button type="button" class="qty-stepper-btn qty-down" data-idx="${idx}"><i class="bi bi-dash"></i></button>
            <input type="number" class="form-control edit-qty-kecil" data-idx="${idx}"
                   value="${item.qtyKecil}" min="0" step="0.01">
            <button type="button" class="qty-stepper-btn qty-up" data-idx="${idx}"><i class="bi bi-plus"></i></button>
          </div>
        </td>
        <td>
          <input type="text" class="form-control edit-price-total text-end" data-idx="${idx}"
                 value="${item.priceTotal ? formatNumber(item.priceTotal) : ''}" placeholder="0" inputmode="decimal">
        </td>
        <td>${matchHTML}</td>
        <td>
          <button class="btn btn-sm btn-outline-danger btn-remove p-0 px-1" data-idx="${idx}" title="Hapus">
            <i class="bi bi-x-lg"></i>
          </button>
        </td>
      `;
      tbody.appendChild(tr);

      // --- Detail row (expandable) ---
      const detailTr = document.createElement('tr');
      detailTr.className = 'item-detail';
      detailTr.dataset.idx = idx;

      const satuanBsr = item.satuanBsr || 'Bsr';
      const mainJualVals = { hjual1: item.hjual1, hjual2: item.hjual2, hjual3: item.hjual3, hjual4: item.hjual4, hjual5: item.hjual5, _enabled: true };

      detailTr.innerHTML = `
        <td colspan="8">
          <div class="dp-grid">
            ${_renderStockInfo(idx, item)}
            <!-- Left: Harga Beli -->
            <div class="dp-section dp-beli">
              <div class="dp-section-header">Harga Beli</div>
              <div class="dp-beli-row">
                <span class="dp-label">Beli</span>
                <span class="dp-val hbeli-bsr" data-idx="${idx}">—</span><span class="dp-unit dp-unit-bsr">/${satuanBsr}</span>
                <span class="dp-val hbeli-pcs" data-idx="${idx}">—</span><span class="dp-unit">/Pcs</span>
              </div>
              <table class="beli-table">
                <thead>
                  <tr>
                    <th></th>
                    <th class="dp-th-total"><span class="dp-unit-bsr">/${satuanBsr}</span> &times; <span class="dp-qty-bsr">${item.qtyBesar || 1}</span> =</th>
                    <th class="dp-unit-bsr">/${satuanBsr}</th>
                    <th>%</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td class="bt-label">D1</td>
                    <td><input type="text" class="amt-total edit-disc-total" data-idx="${idx}" data-field="disc1"
                               value="" placeholder="0" inputmode="decimal"></td>
                    <td><input type="text" class="amt-input edit-disc-amt" data-idx="${idx}" data-field="disc1"
                               value="" placeholder="0" inputmode="decimal"></td>
                    <td><input type="number" class="pct-input edit-disc-pct" data-idx="${idx}" data-field="disc1"
                               value="${item.disc1 != null ? item.disc1 : ''}" placeholder="—" step="any" min="0" max="100"></td>
                  </tr>
                  <tr>
                    <td class="bt-label">D2</td>
                    <td><input type="text" class="amt-total edit-disc-total" data-idx="${idx}" data-field="disc2"
                               value="" placeholder="0" inputmode="decimal"></td>
                    <td><input type="text" class="amt-input edit-disc-amt" data-idx="${idx}" data-field="disc2"
                               value="" placeholder="0" inputmode="decimal"></td>
                    <td><input type="number" class="pct-input edit-disc-pct" data-idx="${idx}" data-field="disc2"
                               value="${item.disc2 != null ? item.disc2 : ''}" placeholder="—" step="any" min="0" max="100"></td>
                  </tr>
                  <tr>
                    <td class="bt-label">D3</td>
                    <td><input type="text" class="amt-total edit-disc-total" data-idx="${idx}" data-field="disc3"
                               value="" placeholder="0" inputmode="decimal"></td>
                    <td><input type="text" class="amt-input edit-disc-amt" data-idx="${idx}" data-field="disc3"
                               value="" placeholder="0" inputmode="decimal"></td>
                    <td><input type="number" class="pct-input edit-disc-pct" data-idx="${idx}" data-field="disc3"
                               value="${item.disc3 != null ? item.disc3 : ''}" placeholder="—" step="any" min="0" max="100"></td>
                  </tr>
                  <tr>
                    <td class="bt-label">PPN</td>
                    <td><input type="text" class="amt-total edit-disc-total" data-idx="${idx}" data-field="ppn"
                               value="" placeholder="0" inputmode="decimal"></td>
                    <td><input type="text" class="amt-input edit-disc-amt" data-idx="${idx}" data-field="ppn"
                               value="" placeholder="0" inputmode="decimal"></td>
                    <td><input type="number" class="pct-input edit-disc-pct" data-idx="${idx}" data-field="ppn"
                               value="${item.ppn != null ? item.ppn : ''}" placeholder="—" step="any" min="0" max="100"></td>
                  </tr>
                  <tr class="beli-row-shipping" title="Dari input Biaya Kirim di bawah, dibagi rata per item">
                    <td class="bt-label">B.Kirim</td>
                    <td colspan="2" class="bt-shipping-val" data-idx="${idx}">—</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
              <div class="dp-netto-row">
                <span class="dp-label">Netto</span>
                <span class="dp-netto-val netto-bsr" data-idx="${idx}">—</span><span class="dp-unit dp-unit-bsr">/${satuanBsr}</span>
                <span class="dp-netto-val netto-pcs" data-idx="${idx}">—</span><span class="dp-unit">/Pcs</span>
              </div>
            </div>
            <!-- Right: Harga Jual -->
            <div class="dp-section dp-jual">
              <div class="dp-section-header">Harga Jual (Satuan)${(item.status === 'auto' && item._refHjual)
                ? ` <span class="auto-adjust-group">
                       <button type="button" class="auto-adjust-toggle btn-round-hundred" data-idx="${idx}" title="Bulatkan ke ratusan">
                         <i class="bi bi-chevron-bar-up"></i> Bulatan 100
                       </button>
                       <button type="button" class="auto-adjust-toggle btn-auto-adjust-jual" data-idx="${idx}">
                         <i class="bi bi-arrow-repeat"></i> Ikuti Margin
                       </button>
                     </span>`
                : ''}</div>
              ${_renderJualTable(idx, null, mainJualVals)}
            </div>
            <!-- Full-width: Bundling -->
            ${_renderBundlingGroup(idx, 1, item.bundling1, item)}
            ${_renderBundlingGroup(idx, 2, item.bundling2, item)}
          </div>
        </td>
      `;
      // Auto-expand detail row if matched or has disc/hjual/bundling data
      const isMatched = item.status === 'auto' && item.matches.length;
      const hasDetail = isMatched || item.disc1 || item.disc2 || item.disc3 || item.ppn ||
                        item.hjual1 || item.hjual2 || item.hjual3 || item.hjual4 || item.hjual5 ||
                        item.bundling1.enabled || item.bundling2.enabled;
      if (hasDetail) {
        detailTr.classList.add('open');
        tr.classList.add('has-detail-open');
      }

      tbody.appendChild(detailTr);
    });

    // --- Bind events ---
    _bindItemEvents();

    // Update computed price displays
    state.items.forEach((_, idx) => _updateComputedPrices(idx));

    dom.itemCount.textContent = `${state.items.length} item`;
    dom.btnClearAll.disabled = false;

    const allMatched = state.items.every((i) => i.status === 'auto' && i.selectedArtno);
    dom.btnPreviewPO.disabled = !allMatched;

    _saveState();
  }

  function _bindItemEvents() {
    // Toggle detail row on main row click
    $$('.item-main').forEach((mainRow) => {
      mainRow.addEventListener('click', (e) => {
        // Don't toggle if clicking on inputs, buttons, or selects
        if (e.target.closest('input, button, select, .btn-review, .match-info')) return;
        const idx = mainRow.dataset.idx;
        const detailRow = document.querySelector(`.item-detail[data-idx="${idx}"]`);
        if (detailRow) {
          detailRow.classList.toggle('open');
          mainRow.classList.toggle('has-detail-open');
        }
      });
    });

    // Name
    $$('.edit-name').forEach((el) => {
      el.addEventListener('change', () => {
        state.items[parseInt(el.dataset.idx)].name = el.value.trim();
        _saveStateDebounced();
      });
    });

    // Barcode — auto-lookup on change
    $$('.edit-barcode').forEach((el) => {
      el.addEventListener('change', async () => {
        const idx = parseInt(el.dataset.idx);
        const barcode = el.value.trim();
        state.items[idx].barcode = barcode;
        if (!barcode) return;

        try {
          const results = await api(`/api/stock/search?q=${encodeURIComponent(barcode)}&limit=10`);
          if (!results.length) return;

          // If top result is a barcode or alias exact match, auto-apply
          const top = results[0];
          if (top.match_type === 'barcode' || top.match_type === 'alias' || top.score >= 95) {
            _applyMatch(idx, top);
            renderItemTable();
          } else {
            // Open match modal for user to pick
            state.currentReviewIdx = idx;
            state.items[idx].matches = results;
            openMatchModal(idx);
          }
        } catch (e) {
          console.warn('Barcode lookup failed:', e.message);
        }
      });
    });

    // Qty Besar
    $$('.edit-qty-besar').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        state.items[idx].qtyBesar = parseFloat(el.value) || 0;
        _recalcFromTotal(idx);
      });
    });

    // Qty Besar stepper buttons
    $$('.qtybsr-up').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        state.items[idx].qtyBesar = (state.items[idx].qtyBesar || 0) + 1;
        const input = btn.parentElement.querySelector('.edit-qty-besar');
        input.value = state.items[idx].qtyBesar;
        _recalcFromTotal(idx);
      });
    });
    $$('.qtybsr-down').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        const current = state.items[idx].qtyBesar || 0;
        if (current <= 0) return;
        state.items[idx].qtyBesar = current - 1;
        const input = btn.parentElement.querySelector('.edit-qty-besar');
        input.value = state.items[idx].qtyBesar;
        _recalcFromTotal(idx);
      });
    });

    // Qty Kecil
    $$('.edit-qty-kecil').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        state.items[idx].qtyKecil = parseFloat(el.value) || 0;
        _recalcFromTotal(idx);
      });
    });

    // Qty Kecil stepper buttons
    $$('.qty-up').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        state.items[idx].qtyKecil = (state.items[idx].qtyKecil || 0) + 1;
        const input = btn.parentElement.querySelector('.edit-qty-kecil');
        input.value = state.items[idx].qtyKecil;
        _recalcFromTotal(idx);
      });
    });
    $$('.qty-down').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        const current = state.items[idx].qtyKecil || 0;
        if (current <= 0) return;
        state.items[idx].qtyKecil = current - 1;
        const input = btn.parentElement.querySelector('.edit-qty-kecil');
        input.value = state.items[idx].qtyKecil;
        _recalcFromTotal(idx);
      });
    });

    // Satuan Besar
    $$('.edit-satuan-bsr').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        state.items[idx].satuanBsr = el.value;
        _updateDetailLabels(idx);
        _updateComputedPrices(idx);
        _saveStateDebounced();
      });
    });

    // Total Harga
    $$('.edit-price-total').forEach((el) => {
      el.addEventListener('input', () => {
        const idx = parseInt(el.dataset.idx);
        state.items[idx].priceTotal = parsePrice(el.value);
        _recalcFromTotal(idx);
      });
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        state.items[idx].priceTotal = parsePrice(el.value);
        el.value = state.items[idx].priceTotal ? formatNumber(state.items[idx].priceTotal) : '';
        _recalcFromTotal(idx);
      });
    });

    // Disc & PPN — dual input: percentage ↔ price amount
    // Helper: get the base amount for a disc field (what the % is applied to)
    function _discBase(item, field) {
      const hbelibsr = item.priceBsr || 0;
      if (!hbelibsr) return 0;
      const net = calcNetPrice(hbelibsr, item.disc1, item.disc2, item.disc3, item.ppn);
      if (field === 'disc1') return hbelibsr;
      if (field === 'disc2') return hbelibsr - net.d1;
      if (field === 'disc3') return hbelibsr - net.d1 - net.d2;
      if (field === 'ppn') return net.netto;
      return hbelibsr;
    }
    // Percentage input → update state + recalc amt (live on input + change)
    $$('.edit-disc-pct').forEach(el => {
      function handler() {
        const idx = parseInt(el.dataset.idx);
        const field = el.dataset.field;
        const item = state.items[idx];
        item[field] = el.value !== '' ? parseFloat(el.value) : null;
        _updateComputedPrices(idx);
        _saveStateDebounced();
      }
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    });
    // Amount input → convert to percentage, update state + recalc (live on input + change)
    $$('.edit-disc-amt').forEach(el => {
      function handler() {
        const idx = parseInt(el.dataset.idx);
        const field = el.dataset.field;
        const item = state.items[idx];
        const amt = parsePrice(el.value);
        if (!amt) {
          item[field] = null;
        } else {
          const base = _discBase(item, field);
          item[field] = base > 0 ? Math.round((amt / base) * 1000000) / 10000 : 0;
        }
        // Update the percentage input to reflect calculated %
        const pctEl = document.querySelector(`.edit-disc-pct[data-idx="${idx}"][data-field="${field}"]`);
        if (pctEl) pctEl.value = item[field] != null ? item[field] : '';
        _updateComputedPrices(idx);
        _saveStateDebounced();
      }
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
      el.addEventListener('blur', () => {
        const v = parsePrice(el.value);
        el.value = v ? formatNumber(v) : '';
      });
    });
    // Total amount input → divide by qty besar to get per-unit, then convert to percentage
    $$('.edit-disc-total').forEach(el => {
      function handler() {
        const idx = parseInt(el.dataset.idx);
        const field = el.dataset.field;
        const item = state.items[idx];
        const totalAmt = parsePrice(el.value);
        const qtyBsr = item.qtyBesar || 1;
        if (!totalAmt) {
          item[field] = null;
        } else {
          const perUnit = totalAmt / qtyBsr;
          const base = _discBase(item, field);
          item[field] = base > 0 ? Math.round((perUnit / base) * 1000000) / 10000 : 0;
        }
        const pctEl = document.querySelector(`.edit-disc-pct[data-idx="${idx}"][data-field="${field}"]`);
        if (pctEl) pctEl.value = item[field] != null ? item[field] : '';
        _updateComputedPrices(idx);
        _saveStateDebounced();
      }
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
      el.addEventListener('blur', () => {
        const v = parsePrice(el.value);
        el.value = v ? formatNumber(v) : '';
      });
    });

    // Unified jual input handler (main + bundling)
    $$('.jual-input').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        const tier = el.dataset.tier; // "main", "1", or "2"
        const field = el.dataset.field; // "hjual1"..."hjual5"
        const val = parsePrice(el.value);
        if (tier === 'main') {
          state.items[idx][field] = val || null;
        } else {
          state.items[idx][`bundling${tier}`][field] = val || null;
        }
        el.value = val ? formatNumber(val) : '';
        _updateComputedPrices(idx);
        _saveStateDebounced();
      });
    });

    // MRG% input handler — edit margin percentage to calculate hjual
    $$('.jual-pct-input').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        const tier = el.dataset.tier;
        const field = el.dataset.field;
        const pctVal = parseFloat(el.value.replace(',', '.'));

        // Calculate nettoPcs for this item
        const item = state.items[idx];
        const hbelibsr = item.priceBsr || 0;
        const qtyKcl = item.packing || 0;
        if (!hbelibsr || qtyKcl <= 0) return;
        const net = calcNetPrice(hbelibsr, item.disc1, item.disc2, item.disc3, item.ppn);
        const nettoPcs = net.final / qtyKcl;
        if (!nettoPcs) return;

        // hjual = nettoPcs * (1 + pct/100)
        const hjual = isNaN(pctVal) ? null : nettoPcs * (1 + pctVal / 100);

        if (tier === 'main') {
          item[field] = hjual || null;
        } else {
          item[`bundling${tier}`][field] = hjual || null;
        }

        // Update the harga input
        const hargaEl = document.querySelector(`.jual-input[data-idx="${idx}"][data-tier="${tier}"][data-field="${field}"]`);
        if (hargaEl) hargaEl.value = hjual ? formatNumber(hjual) : '';

        _updateComputedPrices(idx);
        _saveStateDebounced();
      });
    });

    // Bundling enable toggles
    $$('.bundling-enable').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        const tier = el.dataset.tier; // "1" or "2"
        const b = state.items[idx][`bundling${tier}`];
        b.enabled = el.checked;
        // Toggle min-qty input
        const minQtyEl = document.querySelector(`.bundling-minqty[data-idx="${idx}"][data-tier="${tier}"]`);
        if (minQtyEl) {
          if (el.checked) minQtyEl.removeAttribute('disabled');
          else minQtyEl.setAttribute('disabled', '');
        }
        // Toggle fields visibility
        const fields = document.querySelector(`.bundling-fields[data-idx="${idx}"][data-tier="${tier}"]`);
        if (fields) {
          fields.classList.toggle('bundling-fields-disabled', !el.checked);
          fields.querySelectorAll('input').forEach(inp => {
            if (el.checked) inp.removeAttribute('disabled');
            else inp.setAttribute('disabled', '');
          });
        }
        _saveStateDebounced();
      });
    });

    // Bundling min qty
    $$('.bundling-minqty').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        const tier = el.dataset.tier;
        state.items[idx][`bundling${tier}`].minQty = parseInt(el.value) || 0;
        _saveStateDebounced();
      });
    });

    // Ikuti H.Beli button — one-time adjust jual to match existing margins
    // Round up jual prices to nearest 100
    $$('.btn-round-hundred').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const idx = +btn.dataset.idx;
        const tier = btn.dataset.tier; // undefined for main, "1"/"2" for bundling
        const item = state.items[idx];
        const target = tier ? item[`bundling${tier}`] : item;
        const tierKey = tier || 'main';
        ['hjual1','hjual2','hjual3','hjual4','hjual5'].forEach(f => {
          if (target[f] > 0) target[f] = Math.ceil(target[f] / 100) * 100;
        });
        ['hjual1','hjual2','hjual3','hjual4','hjual5'].forEach(f => {
          const input = document.querySelector(`.jual-input[data-idx="${idx}"][data-tier="${tierKey}"][data-field="${f}"]`);
          if (input) input.value = (target[f] != null && !isNaN(target[f])) ? formatNumber(target[f]) : '';
        });
        _updateComputedPrices(idx);
        _saveStateDebounced();
      });
    });

    // Ikuti Margin — apply same absolute margin from STOK SAAT INI
    $$('.btn-auto-adjust-jual').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const idx = +btn.dataset.idx;
        const tier = btn.dataset.tier; // undefined for main, "1"/"2" for bundling
        _autoAdjustJual(idx, tier);
        _updateComputedPrices(idx);
        _saveStateDebounced();
      });
    });

    // Remove buttons
    $$('.btn-remove').forEach((btn) => {
      btn.addEventListener('click', () => removeItem(parseInt(btn.dataset.idx)));
    });

    // Review/match buttons
    $$('.btn-review').forEach((btn) => {
      btn.addEventListener('click', () => openMatchModal(parseInt(btn.dataset.idx)));
    });
  }

  // -----------------------------------------------------------------------
  // Match All
  // -----------------------------------------------------------------------
  async function _doMatch() {
    const unmatched = state.items.filter((i) => i.status !== 'auto' || !i.selectedArtno);
    if (unmatched.length === 0) return;

    const payload = state.items.map((i) => ({
      name: i.name,
      barcode: i.barcode || '',
      qty: i.qtyBesar,
    }));
    const data = await api('/receipt/match', { method: 'POST', body: { items: payload } });

    data.results.forEach((result, idx) => {
      if (idx >= state.items.length) return;
      const item = state.items[idx];

      // Don't override already auto-matched items
      if (item.status === 'auto' && item.selectedArtno) return;

      item.matches = result.matches || [];
      item.status = result.status;

      if (result.status === 'auto' && result.matches.length) {
        const m = result.matches[0];
        item.selectedArtno = m.artno;
        if (m.artpabrik && !item.barcode) item.barcode = m.artpabrik;
        if (m.satbesar) item.satuanBsr = m.satbesar;
        if (m.packing) item.packing = m.packing;
        // disc/ppn NOT auto-populated — user enters manually
        // Auto-populate harga jual from match
        if (!parseFloat(item.hjual1)) item.hjual1 = parseFloat(m.hjual) || null;
        if (!parseFloat(item.hjual2)) item.hjual2 = parseFloat(m.hjual2) || null;
        if (!parseFloat(item.hjual3)) item.hjual3 = parseFloat(m.hjual3) || null;
        if (!parseFloat(item.hjual4)) item.hjual4 = parseFloat(m.hjual4) || null;
        if (!parseFloat(item.hjual5)) item.hjual5 = parseFloat(m.hjual5) || null;
        // Auto-populate bundling from match
        const bndl = m._bundlings || [];
        [1, 2].forEach((t, i) => {
          const b = item[`bundling${t}`];
          const db = bndl[i];
          if (db && !b.enabled) {
            b.enabled = true;
            b.minQty = db.qty || 0;
            b.hjual1 = parseFloat(db.hjual1) || null;
            b.hjual2 = parseFloat(db.hjual2) || null;
            b.hjual3 = parseFloat(db.hjual3) || null;
            b.hjual4 = parseFloat(db.hjual4) || null;
            b.hjual5 = parseFloat(db.hjual5) || null;
          }
        });
        // Auto-populate price from match if not yet set
        if (m.hbelibsr && !item.priceTotal) {
          item.priceTotal = m.hbelibsr * (item.qtyBesar || 1);
        }
        // Recalculate derived prices (packing may have changed)
        const qty = item.qtyBesar || 1;
        item.priceBsr = qty ? item.priceTotal / qty : item.priceTotal;
        item.priceKcl = item.priceBsr / (item.packing || 1);

        // Store reference values for auto-adjust jual
        const dbBeli = m.hbelibsr || 0;
        const dbNet = calcNetPrice(dbBeli, parseFloat(m.pctdisc1)||0, parseFloat(m.pctdisc2)||0, parseFloat(m.pctdisc3)||0, parseFloat(m.pctppn)||0);
        const dbPacking = parseInt(m.packing) || 1;
        item._refNettoPcs = dbNet.final / dbPacking;
        item._refHjual = { hjual1: parseFloat(item.hjual1)||null, hjual2: parseFloat(item.hjual2)||null, hjual3: parseFloat(item.hjual3)||null, hjual4: parseFloat(item.hjual4)||null, hjual5: parseFloat(item.hjual5)||null };
        item.autoAdjustJual = false;
      }
    });

    renderItemTable();
  }

  // -----------------------------------------------------------------------
  // Match Review Modal
  // -----------------------------------------------------------------------
  async function openMatchModal(idx) {
    state.currentReviewIdx = idx;
    const item = state.items[idx];

    dom.matchOrigName.textContent = item.name;
    dom.matchFilter.value = '';

    // Fresh search using the item name (more candidates for manual review)
    renderMatchCandidates(null, true); // show loading
    try {
      const results = await api(`/api/stock/search?q=${encodeURIComponent(item.name)}&limit=20`);
      item.matches = results;
      renderMatchCandidates(results);
    } catch (e) {
      renderMatchCandidates([]);
    }

    // Bind filter — API search with no min score, scored against receipt name
    dom.matchFilter.oninput = debounce(async () => {
      const q = dom.matchFilter.value.trim();
      if (!q) {
        renderMatchCandidates(item.matches);
        return;
      }
      renderMatchCandidates(null, true); // loading
      try {
        const results = await api(`/api/stock/search?q=${encodeURIComponent(q)}&limit=20&min_score=0&score_against=${encodeURIComponent(item.name)}`);
        renderMatchCandidates(results);
      } catch (e) {
        renderMatchCandidates([]);
      }
    }, 300);

    new bootstrap.Modal(dom.matchModal).show();
    setTimeout(() => dom.matchFilter.focus(), 300);
  }

  function renderMatchCandidates(matches, loading) {
    dom.matchCandidates.innerHTML = '';

    if (loading) {
      dom.matchCandidates.innerHTML = '<p class="text-muted">Mencari...</p>';
      return;
    }

    if (!matches || !matches.length) {
      dom.matchCandidates.innerHTML = '<p class="text-muted">Tidak ada kandidat.</p>';
      return;
    }

    matches.forEach((m) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'list-group-item list-group-item-action';

      const scoreClass = m.score >= 80 ? 'score-high' : m.score >= 60 ? 'score-mid' : 'score-low';
      let badge = '';
      if (m.match_type === 'alias') badge = '<span class="badge bg-info ms-1">alias</span>';
      else if (m.match_type === 'barcode') badge = '<span class="badge bg-primary ms-1">barcode</span>';
      el.innerHTML = `
        <div class="d-flex justify-content-between">
          <div>
            <strong>${m.artname || ''}</strong>${badge}<br>
            <small class="text-muted">${m.artno} | Barcode: ${m.artpabrik || '-'}</small>
          </div>
          <span class="match-score ${scoreClass}">${m.score}%</span>
        </div>
      `;

      el.addEventListener('click', () => selectCandidate(m));
      dom.matchCandidates.appendChild(el);
    });
  }

  function _applyMatch(idx, match) {
    const item = state.items[idx];
    item.selectedArtno = match.artno;
    item.status = 'auto';
    item.matches = [match];
    if (match.artpabrik) item.barcode = match.artpabrik;
    if (match.satbesar) item.satuanBsr = match.satbesar;
    if (match.packing) item.packing = match.packing;
    // disc/ppn NOT auto-populated — user enters manually
    item.hjual1 = parseFloat(match.hjual) || null;
    item.hjual2 = parseFloat(match.hjual2) || null;
    item.hjual3 = parseFloat(match.hjual3) || null;
    item.hjual4 = parseFloat(match.hjual4) || null;
    item.hjual5 = parseFloat(match.hjual5) || null;

    // Auto-fill bundling from existing DB data
    const bundlings = match._bundlings || [];
    [1, 2].forEach((t, i) => {
      const b = item[`bundling${t}`];
      const db = bundlings[i];
      if (db) {
        b.enabled = true;
        b.minQty = db.qty || 0;
        b.hjual1 = db.hjual1 || null;
        b.hjual2 = db.hjual2 || null;
        b.hjual3 = db.hjual3 || null;
        b.hjual4 = db.hjual4 || null;
        b.hjual5 = db.hjual5 || null;
      }
    });

    if (match.hbelibsr && !item.priceTotal) {
      item.priceTotal = match.hbelibsr * (item.qtyBesar || 1);
    }
    const qty = item.qtyBesar || 1;
    item.priceBsr = qty ? item.priceTotal / qty : item.priceTotal;
    item.priceKcl = item.priceBsr / (item.packing || 1);

    // Store reference values for auto-adjust jual
    const dbBeli = match.hbelibsr || 0;
    const dbNet = calcNetPrice(dbBeli, parseFloat(match.pctdisc1)||0, parseFloat(match.pctdisc2)||0, parseFloat(match.pctdisc3)||0, parseFloat(match.pctppn)||0);
    const dbPacking = parseInt(match.packing) || 1;
    item._refNettoPcs = dbNet.final / dbPacking;
    item._refHjual = { hjual1: parseFloat(item.hjual1)||null, hjual2: parseFloat(item.hjual2)||null, hjual3: parseFloat(item.hjual3)||null, hjual4: parseFloat(item.hjual4)||null, hjual5: parseFloat(item.hjual5)||null };
    item.autoAdjustJual = false;
  }

  async function selectCandidate(match) {
    const idx = state.currentReviewIdx;
    _applyMatch(idx, match);

    // Defer alias save — flag intent, actual save happens on PO commit
    state.items[idx]._saveAlias = dom.chkSaveAlias.checked;

    bootstrap.Modal.getInstance(dom.matchModal).hide();
    renderItemTable();
    showToast(`Matched: "${match.artname || match.artno}"`, 'success');
  }

  // -----------------------------------------------------------------------
  // Photo Upload (OCR)
  // -----------------------------------------------------------------------
  async function uploadPhoto() {
    if (!requireHeaderFields()) return;
    const file = dom.photoInput.files[0];
    if (!file) { alert('Pilih foto terlebih dahulu.'); return; }

    const formData = new FormData();
    formData.append('photo', file);

    dom.ocrStatus.textContent = 'Memproses OCR...';
    showSpinner();

    try {
      const data = await api('/receipt/upload-photo', { method: 'POST', body: formData });
      (data.items || []).forEach((item) => {
        const unit = item.unit && item.unit !== '?' ? item.unit : 'CTN';
        const packing = item.packing && item.packing > 0 ? item.packing : 1;
        addItem(item.name, '', item.qty, 0, unit, packing, item.price || 0);
      });
      dom.ocrStatus.textContent = `${data.items.length} baris terdeteksi. Matching...`;
      dom.photoInput.value = '';

      // Auto-match all added items
      await _doMatch();
      dom.ocrStatus.textContent = `${data.items.length} baris terdeteksi & matched.`;
    } catch (e) {
      dom.ocrStatus.textContent = 'OCR gagal: ' + e.message;
    } finally {
      hideSpinner();
    }
  }

  // -----------------------------------------------------------------------
  // CSV Upload
  // -----------------------------------------------------------------------
  async function uploadCSV() {
    if (!requireHeaderFields()) return;
    const file = dom.csvInput.files[0];
    if (!file) { alert('Pilih file CSV/Excel terlebih dahulu.'); return; }

    const formData = new FormData();
    formData.append('file', file);

    showSpinner();
    try {
      const data = await api('/receipt/upload-csv', { method: 'POST', body: formData });
      (data.items || []).forEach((item) => {
        addItem(item.name, '', item.qty, 0, 'CTN', 1, item.price || 0);
      });
      dom.csvInput.value = '';

      // Auto-match all added items
      await _doMatch();
    } catch (e) {
      alert('Import gagal: ' + e.message);
    } finally {
      hideSpinner();
    }
  }

  // -----------------------------------------------------------------------
  // PO Preview
  // -----------------------------------------------------------------------
  function _buildBundlingPayload(b) {
    if (!b || !b.enabled || !b.minQty) return null;
    return {
      min_qty: b.minQty,
      hjual1: b.hjual1,
      hjual2: b.hjual2,
      hjual3: b.hjual3,
      hjual4: b.hjual4,
      hjual5: b.hjual5,
    };
  }

  function _buildItemPayload(i) {
    const payload = {
      artno: i.selectedArtno,
      qty: computeQty(i),
      qty_besar: i.qtyBesar || 0,
      price_override: i.priceBsr || 0,
      disc1_override: i.disc1,
      disc2_override: i.disc2,
      disc3_override: i.disc3,
      ppn_override: i.ppn,
      hjual1_override: i.hjual1,
      hjual2_override: i.hjual2,
      hjual3_override: i.hjual3,
      hjual4_override: i.hjual4,
      hjual5_override: i.hjual5,
    };
    const b1 = _buildBundlingPayload(i.bundling1);
    const b2 = _buildBundlingPayload(i.bundling2);
    if (b1) payload.bundling1 = b1;
    if (b2) payload.bundling2 = b2;
    return payload;
  }

  async function previewPO() {
    if (!requireHeaderFields()) return;
    const userId = dom.userSelect.value;
    const supplierId = dom.vendorSelect.value;

    const shippingCost = parsePrice(dom.shippingCostInput.value);
    const items = state.items
      .filter((i) => i.selectedArtno)
      .map(_buildItemPayload);

    if (!items.length) { alert('Tidak ada item yang sudah di-match.'); return; }

    showSpinner();
    try {
      const data = await api('/receipt/preview', {
        method: 'POST',
        body: {
          supplier_id: supplierId,
          items,
          order_date: dom.orderDate.value,
          shipping_cost: shippingCost,
        },
      });

      renderPOPreview(data);
      new bootstrap.Modal(dom.poPreviewModal).show();
    } catch (e) {
      alert('Preview gagal: ' + e.message);
    } finally {
      hideSpinner();
    }
  }

  function renderPOPreview(data) {
    const vendor = state.vendors.find((v) => v.id === data.supplier_id);
    dom.poSupplierName.textContent = vendor ? `${vendor.id} - ${vendor.name}` : data.supplier_id;
    dom.poDate.textContent = data.order_date;
    dom.poGrandTotal.textContent = formatNumber(data.grand_total);

    const fmtDisc = (v) => {
      if (!v) return '<span class="po-disc-zero">-</span>';
      const n = parseFloat(v);
      if (n === 0) return '<span class="po-disc-zero">-</span>';
      return Number.isInteger(n) ? n.toString() : n.toFixed(2);
    };

    dom.poPreviewBody.innerHTML = '';
    let totalAmount = 0;
    data.lines.forEach((line, i) => {
      totalAmount += line.amount || 0;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="po-rownum">${i + 1}</td>
        <td class="po-artno">${line.artno}</td>
        <td>${line.artname}</td>
        <td class="po-num">${line.qty_besar || line.qty}</td>
        <td>${line.satuanbsr}</td>
        <td class="po-num">${formatNumber(line.hbelibsr)}</td>
        <td class="po-num">${formatNumber(line.hbelikcl)}</td>
        <td class="po-num">${fmtDisc(line.pctdisc1)}</td>
        <td class="po-num">${fmtDisc(line.pctdisc2)}</td>
        <td class="po-num">${fmtDisc(line.pctdisc3)}</td>
        <td class="po-num">${fmtDisc(line.pctppn)}</td>
        <td class="po-num">${formatNumber(line.netto_full)}</td>
        <td class="po-num">${formatNumber(line.netto_full * (line.qty_besar || line.qty))}</td>
        <td class="po-num po-amount">${formatNumber(line.amount)}</td>
      `;
      dom.poPreviewBody.appendChild(tr);
    });

    // Grand total row
    const trTotal = document.createElement('tr');
    trTotal.className = 'po-row-grand-total';
    trTotal.innerHTML = `
      <td colspan="13" class="text-end">Grand Total</td>
      <td class="po-num po-grand-total-value">${formatNumber(data.grand_total)}</td>
    `;
    dom.poPreviewBody.appendChild(trTotal);
  }

  // -----------------------------------------------------------------------
  // PO Commit
  // -----------------------------------------------------------------------
  async function commitPO() {
    if (!confirm('Buat Purchase Order dan update stok?\nAksi ini tidak bisa dibatalkan.')) return;

    const userId = dom.userSelect.value;
    const supplierId = dom.vendorSelect.value;
    const shippingCost = parsePrice(dom.shippingCostInput.value);
    const items = state.items
      .filter((i) => i.selectedArtno)
      .map(_buildItemPayload);

    showSpinner();
    try {
      const data = await api('/receipt/commit', {
        method: 'POST',
        body: {
          supplier_id: supplierId,
          userid: userId,
          items,
          order_date: dom.orderDate.value,
          shipping_cost: shippingCost,
        },
      });

      // Close preview, show success — clear draft
      bootstrap.Modal.getInstance(dom.poPreviewModal).hide();
      _clearSavedState();

      // Save aliases for items that were flagged during match selection
      for (const item of state.items) {
        if (item._saveAlias && item.selectedArtno) {
          try {
            await api('/receipt/save-alias', {
              method: 'POST',
              body: { alias_name: item.name, artno: item.selectedArtno, userid: userId },
            });
          } catch (e) {
            console.warn('Alias save failed for', item.name, e.message);
          }
        }
      }

      dom.successPONumber.textContent = data.po_number;
      dom.successTotal.textContent = formatNumber(data.grand_total);
      dom.successLineCount.textContent = data.line_count;

      setTimeout(() => {
        new bootstrap.Modal(dom.poSuccessModal).show();
      }, 300);
    } catch (e) {
      alert('Commit PO gagal: ' + e.message);
    } finally {
      hideSpinner();
    }
  }

  // -----------------------------------------------------------------------
  // Boot
  // -----------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', init);
})();
