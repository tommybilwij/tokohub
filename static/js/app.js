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
    btnMatchAll:     $('#btnMatchAll'),
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
    return Math.round(n).toLocaleString('en-US');
  }

  function parsePrice(str) {
    return parseInt(String(str).replace(/[^0-9]/g, ''), 10) || 0;
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
    return { d1: Math.round(d1), d2: Math.round(d2), d3: Math.round(d3), ppnAmt: Math.round(ppnAmt), netto: Math.round(netto), final: Math.round(netto + ppnAmt) };
  }

  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
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
    el.innerHTML = '<div class="spinner-border text-success" style="width:3rem;height:3rem"></div>';
    document.body.appendChild(el);
  }

  function hideSpinner() {
    const el = $('#globalSpinner');
    if (el) el.remove();
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------
  function init() {
    // Guard: only run on receipt form page
    if (!dom.vendorSelect) return;

    // Set today's date
    if (dom.orderDate) {
      dom.orderDate.value = new Date().toISOString().slice(0, 10);
    }

    loadUsers();
    loadVendors();
    bindEvents();
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
    dom.btnMatchAll.addEventListener('click', matchAllItems);
    dom.btnPreviewPO.addEventListener('click', previewPO);
    dom.btnClearAll.addEventListener('click', clearAllItems);

    // Shipping cost: format on blur
    dom.shippingCostInput.addEventListener('change', () => {
      const val = parsePrice(dom.shippingCostInput.value);
      dom.shippingCostInput.value = val ? formatNumber(val) : '0';
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
                item.pctdisc1 ?? null, item.pctdisc2 ?? null, item.pctdisc3 ?? null, item.pctppn ?? null);
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
    });
    renderItemTable();
  }

  function removeItem(idx) {
    state.items.splice(idx, 1);
    renderItemTable();
  }

  function clearAllItems() {
    state.items = [];
    renderItemTable();
  }

  // Render a jual price table (reusable for main + bundling tiers)
  // tier: null = main, 1 = bundling1, 2 = bundling2
  function _renderJualTable(idx, tier, values) {
    const t = tier == null ? 'main' : tier;
    const dis = tier != null && !values._enabled ? 'disabled' : '';
    const rows = [
      { label: 'Jual 1', field: 'hjual1' },
      { label: 'Member', field: 'hjual2' },
      { label: 'Jual 3', field: 'hjual3' },
      { label: 'Jual 4', field: 'hjual4' },
      { label: 'Jual 5', field: 'hjual5' },
    ];
    const rowsHTML = rows.map(r => {
      const val = values[r.field];
      return `<tr>
        <td class="jt-label">${r.label}</td>
        <td><input type="text" class="jual-input" data-idx="${idx}" data-tier="${t}" data-field="${r.field}"
                   value="${val != null ? formatNumber(val) : ''}" placeholder="—" inputmode="numeric" ${dis}></td>
        <td class="jt-pct"><span class="jual-pct" data-idx="${idx}" data-tier="${t}" data-field="${r.field}">—</span></td>
        <td class="jt-margin"><span class="jual-margin" data-idx="${idx}" data-tier="${t}" data-field="${r.field}">—</span></td>
      </tr>`;
    }).join('');
    return `<table class="jual-table"><thead><tr><th></th><th>Harga</th><th>Mrg%</th><th>Margin</th></tr></thead><tbody>${rowsHTML}</tbody></table>`;
  }

  // Render a bundling group (1 or 2) for the detail panel
  function _renderBundlingGroup(idx, tier, b) {
    const checked = b.enabled ? 'checked' : '';
    const disabled = b.enabled ? '' : 'disabled';
    const vals = { hjual1: b.hjual1, hjual2: b.hjual2, hjual3: b.hjual3, hjual4: b.hjual4, hjual5: b.hjual5, _enabled: b.enabled };
    return `
      <div class="dp-bundling-section">
        <div class="dp-section-header">
          <label class="bundling-toggle">
            <input type="checkbox" class="form-check-input bundling-enable" data-idx="${idx}" data-tier="${tier}" ${checked}>
            Bundling ${tier}
          </label>
          <span class="bundling-qty-wrap">Qty &ge;
            <input type="number" class="bundling-minqty" data-idx="${idx}" data-tier="${tier}"
                   value="${b.minQty || ''}" placeholder="0" min="1" step="1" ${disabled}>
          </span>
        </div>
        <div class="bundling-fields" data-idx="${idx}" data-tier="${tier}" ${b.enabled ? '' : 'style="opacity:0.4;pointer-events:none"'}>
          ${_renderJualTable(idx, tier, vals)}
        </div>
      </div>`;
  }

  // Price recalculation helper (used by render and event handlers)
  function _recalcFromTotal(idx) {
    const item = state.items[idx];
    const qty = item.qtyBesar || 1;
    item.priceBsr = qty ? item.priceTotal / qty : item.priceTotal;
    item.priceKcl = item.qtyKecil > 0 ? item.priceBsr / item.qtyKecil : 0;

    const bsrEl = document.querySelector(`.harga-bsr[data-idx="${idx}"]`);
    const kclEl = document.querySelector(`.harga-kcl[data-idx="${idx}"]`);
    if (bsrEl) bsrEl.textContent = item.priceBsr ? formatNumber(Math.round(item.priceBsr)) : '—';
    if (kclEl) kclEl.textContent = item.qtyKecil > 0 && item.priceKcl ? formatNumber(Math.round(item.priceKcl)) : '—';
    _updateComputedPrices(idx);
  }

  function _updateComputedPrices(idx) {
    const item = state.items[idx];
    const hbelibsr = item.priceBsr || 0;
    // Use qtyKecil (user-entered pcs/pak) for /Pcs display, consistent with main row H/Kcl
    const qtyKcl = item.qtyKecil || 0;
    const showPcs = qtyKcl > 0;

    // H.Beli /Bsr and /Pcs
    const hbeliBsrEl = document.querySelector(`.hbeli-bsr[data-idx="${idx}"]`);
    const hbeliPcsEl = document.querySelector(`.hbeli-pcs[data-idx="${idx}"]`);
    if (hbeliBsrEl) hbeliBsrEl.textContent = hbelibsr ? formatNumber(Math.round(hbelibsr)) : '—';
    if (hbeliPcsEl) hbeliPcsEl.textContent = (hbelibsr && showPcs) ? formatNumber(Math.round(hbelibsr / qtyKcl)) : '—';

    // Disc amounts
    const net = calcNetPrice(hbelibsr, item.disc1, item.disc2, item.disc3, item.ppn);
    const d1El = document.querySelector(`.disc-amt-1[data-idx="${idx}"]`);
    const d2El = document.querySelector(`.disc-amt-2[data-idx="${idx}"]`);
    const d3El = document.querySelector(`.disc-amt-3[data-idx="${idx}"]`);
    const ppnEl = document.querySelector(`.ppn-amt[data-idx="${idx}"]`);
    if (d1El) d1El.textContent = formatNumber(net.d1);
    if (d2El) d2El.textContent = formatNumber(net.d2);
    if (d3El) d3El.textContent = formatNumber(net.d3);
    if (ppnEl) ppnEl.textContent = formatNumber(net.ppnAmt);

    // Netto /Bsr and /Pcs (final = netto + ppn)
    const nettoBsrEl = document.querySelector(`.netto-bsr[data-idx="${idx}"]`);
    const nettoPcsEl = document.querySelector(`.netto-pcs[data-idx="${idx}"]`);
    if (hbelibsr) {
      if (nettoBsrEl) nettoBsrEl.textContent = formatNumber(net.final);
      if (nettoPcsEl) nettoPcsEl.textContent = showPcs ? formatNumber(Math.round(net.final / qtyKcl)) : '—';
    } else {
      if (nettoBsrEl) nettoBsrEl.textContent = '—';
      if (nettoPcsEl) nettoPcsEl.textContent = '—';
    }

    // Reference cost per pcs for markup calculations (uses qtyKecil to match display)
    const nettoPcs = (hbelibsr && showPcs) ? net.final / qtyKcl : 0;

    // Update jual markup% and margin for a given tier
    function updateJualRow(tier, field, hjualVal) {
      const pctEl = document.querySelector(`.jual-pct[data-idx="${idx}"][data-tier="${tier}"][data-field="${field}"]`);
      const mrgEl = document.querySelector(`.jual-margin[data-idx="${idx}"][data-tier="${tier}"][data-field="${field}"]`);
      if (!pctEl || !mrgEl) return;
      if (hjualVal == null || hjualVal <= 0 || !nettoPcs) {
        pctEl.textContent = '—';
        mrgEl.textContent = '—';
        pctEl.classList.remove('negative');
        mrgEl.classList.remove('negative');
        return;
      }
      const margin = hjualVal - nettoPcs;
      const pct = (margin / nettoPcs) * 100;
      const isNeg = margin < 0;
      pctEl.textContent = isNeg ? `(${Math.abs(pct).toFixed(1)}%)` : `${pct.toFixed(1)}%`;
      mrgEl.textContent = isNeg ? `(${formatNumber(Math.abs(Math.round(margin)))})` : formatNumber(Math.round(margin));
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

  function renderItemTable() {
    const tbody = dom.itemTableBody;
    tbody.innerHTML = '';

    if (state.items.length === 0) {
      tbody.innerHTML = `
        <tr><td colspan="10" class="text-center text-muted py-5">
          <i class="bi bi-inbox" style="font-size:2rem;opacity:0.3"></i><br>
          <span class="mt-2 d-inline-block">Belum ada barang. Tambahkan dari panel kiri.</span>
        </td></tr>`;
      dom.itemCount.textContent = '0 item';
      dom.btnMatchAll.disabled = true;
      dom.btnPreviewPO.disabled = true;
      dom.btnClearAll.disabled = true;
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
        if (m.match_type === 'alias') typeBadge = '<span class="badge bg-info">alias</span>';
        else if (m.match_type === 'barcode') typeBadge = '<span class="badge bg-primary">barcode</span>';
        else typeBadge = `<span class="badge bg-success">${m.score}%</span>`;

        const packNum = m.packing ? parseInt(m.packing) : '';
        const hbelikcl = m.hbelikcl || (m.hbelibsr && packNum ? Math.round(m.hbelibsr / packNum) : 0);

        // Build jual grid rows (only non-zero)
        const jualItems = [
          { label: 'Jual 1', val: m.hjual },
          { label: 'Jual 3', val: m.hjual3 },
          { label: 'Jual 4', val: m.hjual4 },
          { label: 'Jual 5', val: m.hjual5 },
          { label: 'Member', val: m.hjual2 },
        ].filter(j => j.val);

        const jualHTML = jualItems.length
          ? `<div class="si-section">
              <div class="si-label">Harga Jual (Saat Ini)</div>
              <div class="si-grid">${jualItems.map(j =>
                `<div class="si-cell"><span class="si-cell-label">${j.label}</span><span class="si-cell-value">${formatNumber(j.val)}</span></div>`
              ).join('')}</div>
            </div>`
          : '';

        // Bundling data from DB (if any)
        const bundlings = m._bundlings || [];
        const bundlingHTML = bundlings.length
          ? bundlings.map((b, bi) => {
              const bJual = [
                { label: 'J1', val: b.hjual1 },
                { label: 'J3', val: b.hjual3 },
                { label: 'J4', val: b.hjual4 },
                { label: 'J5', val: b.hjual5 },
                { label: 'Mbr', val: b.hjual2 },
              ].filter(j => j.val);
              return `<div class="si-section">
                <div class="si-label si-label-bundling">Bundling ${bi + 1} — Qty &ge; ${b.qty}</div>
                <div class="si-grid">${bJual.map(j =>
                  `<div class="si-cell si-cell-bundling"><span class="si-cell-label">${j.label}</span><span class="si-cell-value">${formatNumber(j.val)}</span></div>`
                ).join('')}</div>
              </div>`;
            }).join('')
          : '';

        // Disc/PPN pills (only non-zero)
        const discItems = [];
        if (m.pctdisc1) discItems.push({ label: 'D1', val: m.pctdisc1 });
        if (m.pctdisc2) discItems.push({ label: 'D2', val: m.pctdisc2 });
        if (m.pctdisc3) discItems.push({ label: 'D3', val: m.pctdisc3 });
        if (m.pctppn) discItems.push({ label: 'PPN', val: m.pctppn });
        const discHTML = discItems.length
          ? `<div class="si-pills">${discItems.map(d =>
              `<span class="si-pill">${d.label} <b>${d.val}%</b></span>`
            ).join('')}</div>`
          : '';

        // Net price after cascading discounts & PPN
        const hasDiscOrPpn = m.pctdisc1 || m.pctdisc2 || m.pctdisc3 || m.pctppn;
        const netPrices = hasDiscOrPpn ? calcNetPrice(m.hbelibsr || 0, m.pctdisc1, m.pctdisc2, m.pctdisc3, m.pctppn) : null;
        const nettoHTML = netPrices
          ? `<div class="si-prices si-prices-netto">
              <div class="si-price-item si-price-netto">
                <span class="si-price-caption">Netto / ${m.satbesar || 'Bsr'}</span>
                <span class="si-price-amount si-netto-amount">${formatNumber(netPrices.netto)}</span>
              </div>
              <div class="si-price-item si-price-netto">
                <span class="si-price-caption">+PPN / ${m.satbesar || 'Bsr'}</span>
                <span class="si-price-amount si-netto-amount">${formatNumber(netPrices.final)}</span>
              </div>
            </div>`
          : '';

        matchHTML = `
          <button class="btn btn-sm btn-success btn-review" data-idx="${idx}" title="Klik untuk ganti">
            ${m.artname || m.artno}
          </button>
          <div class="stock-info-card">
            <div class="si-header">
              ${typeBadge}
              <span class="si-artno">${m.artno}</span>
              <span class="si-packing">${packNum || '-'} ${m.satkecil || 'Pcs'} / ${m.satbesar || '-'}</span>
            </div>
            <div class="si-body">
              <div class="si-section">
                <div class="si-label">Harga Beli (Saat Ini)</div>
                <div class="si-prices">
                  <div class="si-price-item">
                    <span class="si-price-caption">/ ${m.satbesar || 'Bsr'}</span>
                    <span class="si-price-amount">${formatNumber(m.hbelibsr || 0)}</span>
                  </div>
                  <div class="si-price-item">
                    <span class="si-price-caption">/ ${m.satkecil || 'Pcs'}</span>
                    <span class="si-price-amount si-price-small">${formatNumber(hbelikcl)}</span>
                  </div>
                </div>
                ${discHTML}
                ${nettoHTML}
              </div>
              ${jualHTML}
              ${bundlingHTML}
            </div>
          </div>`;
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
                 value="${item.name.replace(/"/g, '&quot;')}">
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
                     value="${item.qtyBesar}" min="0" step="1">
              <button type="button" class="qty-stepper-btn qtybsr-up" data-idx="${idx}"><i class="bi bi-plus"></i></button>
            </div>
            <select class="form-select edit-satuan-bsr" data-idx="${idx}" style="width:72px">
              ${unitOpts}
            </select>
          </div>
        </td>
        <td>
          <div class="qty-stepper">
            <button type="button" class="qty-stepper-btn qty-down" data-idx="${idx}"><i class="bi bi-dash"></i></button>
            <input type="number" class="form-control edit-qty-kecil" data-idx="${idx}"
                   value="${item.qtyKecil}" min="0" step="1">
            <button type="button" class="qty-stepper-btn qty-up" data-idx="${idx}"><i class="bi bi-plus"></i></button>
          </div>
        </td>
        <td>
          <input type="text" class="form-control edit-price-total text-end" data-idx="${idx}"
                 value="${item.priceTotal ? formatNumber(Math.round(item.priceTotal)) : ''}" placeholder="0" inputmode="numeric">
        </td>
        <td class="text-end price-readonly harga-bsr" data-idx="${idx}">
          ${item.priceBsr ? formatNumber(Math.round(item.priceBsr)) : '—'}
        </td>
        <td class="text-end price-readonly harga-kcl" data-idx="${idx}">
          ${item.qtyKecil > 0 && item.priceBsr ? formatNumber(Math.round(item.priceBsr / item.qtyKecil)) : '—'}
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
        <td colspan="10">
          <div class="dp-grid">
            <!-- Left: Harga Beli -->
            <div class="dp-section dp-beli">
              <div class="dp-section-header">Harga Beli</div>
              <div class="dp-beli-row">
                <span class="dp-label">H.Beli</span>
                <span class="dp-val hbeli-bsr" data-idx="${idx}">—</span><span class="dp-unit">/${satuanBsr}</span>
                <span class="dp-val hbeli-pcs" data-idx="${idx}">—</span><span class="dp-unit">/Pcs</span>
              </div>
              <div class="dp-disc-row">
                <div class="dp-disc-field">
                  <span class="dp-disc-lbl">D1</span>
                  <input type="number" class="pct-input edit-disc1" data-idx="${idx}"
                         value="${item.disc1 != null ? item.disc1 : ''}" placeholder="—" step="any" min="0" max="100">
                  <span class="dp-disc-eq">% =</span>
                  <span class="dp-disc-amt disc-amt-1" data-idx="${idx}">0</span>
                </div>
                <div class="dp-disc-field">
                  <span class="dp-disc-lbl">D2</span>
                  <input type="number" class="pct-input edit-disc2" data-idx="${idx}"
                         value="${item.disc2 != null ? item.disc2 : ''}" placeholder="—" step="any" min="0" max="100">
                  <span class="dp-disc-eq">% =</span>
                  <span class="dp-disc-amt disc-amt-2" data-idx="${idx}">0</span>
                </div>
              </div>
              <div class="dp-disc-row">
                <div class="dp-disc-field">
                  <span class="dp-disc-lbl">D3</span>
                  <input type="number" class="pct-input edit-disc3" data-idx="${idx}"
                         value="${item.disc3 != null ? item.disc3 : ''}" placeholder="—" step="any" min="0" max="100">
                  <span class="dp-disc-eq">% =</span>
                  <span class="dp-disc-amt disc-amt-3" data-idx="${idx}">0</span>
                </div>
                <div class="dp-disc-field">
                  <span class="dp-disc-lbl">PPN</span>
                  <input type="number" class="pct-input edit-ppn" data-idx="${idx}"
                         value="${item.ppn != null ? item.ppn : ''}" placeholder="—" step="any" min="0" max="100">
                  <span class="dp-disc-eq">% =</span>
                  <span class="dp-disc-amt ppn-amt" data-idx="${idx}">0</span>
                </div>
              </div>
              <div class="dp-netto-row">
                <span class="dp-label">Netto</span>
                <span class="dp-netto-val netto-bsr" data-idx="${idx}">—</span><span class="dp-unit">/${satuanBsr}</span>
                <span class="dp-netto-val netto-pcs" data-idx="${idx}">—</span><span class="dp-unit">/Pcs</span>
              </div>
            </div>
            <!-- Right: Harga Jual -->
            <div class="dp-section dp-jual">
              <div class="dp-section-header">Harga Jual</div>
              ${_renderJualTable(idx, null, mainJualVals)}
            </div>
            <!-- Full-width: Bundling -->
            ${_renderBundlingGroup(idx, 1, item.bundling1)}
            ${_renderBundlingGroup(idx, 2, item.bundling2)}
          </div>
        </td>
      `;
      // Auto-expand detail row if it has disc/hjual/bundling data
      const hasDetail = item.disc1 || item.disc2 || item.disc3 || item.ppn ||
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
    dom.btnMatchAll.disabled = false;
    dom.btnClearAll.disabled = false;

    const allMatched = state.items.every((i) => i.status === 'auto' && i.selectedArtno);
    dom.btnPreviewPO.disabled = !allMatched;
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
        state.items[parseInt(el.dataset.idx)].satuanBsr = el.value;
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
        el.value = state.items[idx].priceTotal ? formatNumber(Math.round(state.items[idx].priceTotal)) : '';
        _recalcFromTotal(idx);
      });
    });

    // Disc & PPN (in detail row)
    $$('.edit-disc1').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        state.items[idx].disc1 = el.value !== '' ? parseFloat(el.value) : null;
        _updateComputedPrices(idx);
      });
    });
    $$('.edit-disc2').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        state.items[idx].disc2 = el.value !== '' ? parseFloat(el.value) : null;
        _updateComputedPrices(idx);
      });
    });
    $$('.edit-disc3').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        state.items[idx].disc3 = el.value !== '' ? parseFloat(el.value) : null;
        _updateComputedPrices(idx);
      });
    });
    $$('.edit-ppn').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        state.items[idx].ppn = el.value !== '' ? parseFloat(el.value) : null;
        _updateComputedPrices(idx);
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
      });
    });

    // Bundling enable toggles
    $$('.bundling-enable').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        const tier = el.dataset.tier; // "1" or "2"
        const b = state.items[idx][`bundling${tier}`];
        b.enabled = el.checked;
        // Toggle fields visibility
        const fields = document.querySelector(`.bundling-fields[data-idx="${idx}"][data-tier="${tier}"]`);
        if (fields) {
          fields.style.opacity = el.checked ? '1' : '0.4';
          fields.style.pointerEvents = el.checked ? '' : 'none';
          fields.querySelectorAll('input').forEach(inp => {
            if (el.checked) inp.removeAttribute('disabled');
            else inp.setAttribute('disabled', '');
          });
        }
      });
    });

    // Bundling min qty
    $$('.bundling-minqty').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        const tier = el.dataset.tier;
        state.items[idx][`bundling${tier}`].minQty = parseInt(el.value) || 0;
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
        item.disc1 = m.pctdisc1 ?? null;
        item.disc2 = m.pctdisc2 ?? null;
        item.disc3 = m.pctdisc3 ?? null;
        item.ppn = m.pctppn ?? null;
        // Auto-populate harga jual from match
        if (item.hjual1 == null) item.hjual1 = m.hjual || null;
        if (item.hjual2 == null) item.hjual2 = m.hjual2 || null;
        if (item.hjual3 == null) item.hjual3 = m.hjual3 || null;
        if (item.hjual4 == null) item.hjual4 = m.hjual4 || null;
        if (item.hjual5 == null) item.hjual5 = m.hjual5 || null;
        // Auto-populate price from match if not yet set
        if (m.hbelibsr && !item.priceTotal) {
          item.priceTotal = m.hbelibsr * (item.qtyBesar || 1);
        }
        // Recalculate derived prices (packing may have changed)
        const qty = item.qtyBesar || 1;
        item.priceBsr = qty ? item.priceTotal / qty : item.priceTotal;
        item.priceKcl = item.priceBsr / (item.packing || 1);
      }
    });

    renderItemTable();
  }

  async function matchAllItems() {
    if (!requireHeaderFields()) return;

    showSpinner();
    try {
      await _doMatch();
    } catch (e) {
      alert('Match gagal: ' + e.message);
    } finally {
      hideSpinner();
    }
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
    item.disc1 = match.pctdisc1 ?? null;
    item.disc2 = match.pctdisc2 ?? null;
    item.disc3 = match.pctdisc3 ?? null;
    item.ppn = match.pctppn ?? null;
    item.hjual1 = match.hjual || null;
    item.hjual2 = match.hjual2 || null;
    item.hjual3 = match.hjual3 || null;
    item.hjual4 = match.hjual4 || null;
    item.hjual5 = match.hjual5 || null;
    if (match.hbelibsr && !item.priceTotal) {
      item.priceTotal = match.hbelibsr * (item.qtyBesar || 1);
    }
    const qty = item.qtyBesar || 1;
    item.priceBsr = qty ? item.priceTotal / qty : item.priceTotal;
    item.priceKcl = item.priceBsr / (item.packing || 1);
  }

  async function selectCandidate(match) {
    const idx = state.currentReviewIdx;
    _applyMatch(idx, match);

    // Save alias if checkbox checked
    if (dom.chkSaveAlias.checked) {
      try {
        await api('/receipt/save-alias', {
          method: 'POST',
          body: { alias_name: state.items[idx].name, artno: match.artno, userid: dom.userSelect.value },
        });
      } catch (e) {
        console.warn('Alias save failed:', e.message);
      }
    }

    bootstrap.Modal.getInstance(dom.matchModal).hide();
    renderItemTable();
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
        addItem(item.name, '', item.qty, 0, unit, 1, item.price || 0);
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

    dom.poPreviewBody.innerHTML = '';
    data.lines.forEach((line, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td><code>${line.artno}</code></td>
        <td>${line.artname}</td>
        <td class="text-end">${line.qty}</td>
        <td>${line.satuanbsr}</td>
        <td class="text-end">${formatNumber(line.hbelibsr)}</td>
        <td class="text-end">${formatNumber(line.hbelikcl)}</td>
        <td class="text-end">${line.pctdisc1 || ''}</td>
        <td class="text-end">${line.pctdisc2 || ''}</td>
        <td class="text-end">${line.pctdisc3 || ''}</td>
        <td class="text-end">${line.pctppn || ''}</td>
        <td class="text-end">${formatNumber(line.hbelinetto)}</td>
        <td class="text-end">${formatNumber(line.amount)}</td>
      `;
      dom.poPreviewBody.appendChild(tr);
    });

    // Show shipping cost row if present
    if (data.shipping_cost > 0) {
      const tr = document.createElement('tr');
      tr.className = 'table-info';
      tr.innerHTML = `
        <td colspan="12" class="text-end fw-semibold">Biaya Kirim (ditambahkan ke PPN)</td>
        <td class="text-end fw-semibold">${formatNumber(data.shipping_cost)}</td>
      `;
      dom.poPreviewBody.appendChild(tr);
    }
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

      // Close preview, show success
      bootstrap.Modal.getInstance(dom.poPreviewModal).hide();

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
