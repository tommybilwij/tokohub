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

  function renderItemTable() {
    const tbody = dom.itemTableBody;
    tbody.innerHTML = '';

    if (state.items.length === 0) {
      tbody.innerHTML = `
        <tr><td colspan="14" class="text-center text-muted py-4">
          Belum ada barang. Tambahkan dari panel kiri.
        </td></tr>`;
      dom.itemCount.textContent = '0 item';
      dom.btnMatchAll.disabled = true;
      dom.btnPreviewPO.disabled = true;
      dom.btnClearAll.disabled = true;
      return;
    }

    state.items.forEach((item, idx) => {
      const tr = document.createElement('tr');
      tr.className = `item-row-${item.status}`;

      let matchHTML = '';
      if (item.status === 'auto' && item.matches.length) {
        const m = item.matches[0];
        let typeBadge = '';
        if (m.match_type === 'alias') typeBadge = '<span class="badge bg-info">alias</span>';
        else if (m.match_type === 'barcode') typeBadge = '<span class="badge bg-primary">barcode</span>';
        else typeBadge = `<span class="badge bg-success">${m.score}%</span>`;

        const packNum = m.packing ? parseInt(m.packing) : '';
        matchHTML = `
          <button class="btn btn-sm btn-success btn-review" data-idx="${idx}" title="Klik untuk ganti">
            ${m.artname || m.artno}
          </button>
          <div class="match-info mt-1">
            <div class="match-info-header">${typeBadge} <span class="match-artno">${m.artno}</span></div>
            <div class="match-info-row">
              <span class="match-label">Beli</span>
              <span class="match-value">${formatNumber(m.hbelibsr || 0)}</span>
              <span class="match-label ms-3">Jual</span>
              <span class="match-value">${formatNumber(m.hjual || 0)}</span>
            </div>
            <div class="match-info-row">
              <span class="match-label">Isi</span>
              <span class="match-value">1 ${m.satbesar || '-'} / ${packNum || '-'} ${m.satkecil || 'Pcs'}</span>
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

      // Build unit dropdown options
      const unitOpts = UNIT_OPTIONS.map(u =>
        `<option value="${u}"${u === item.satuanBsr ? ' selected' : ''}>${u}</option>`
      ).join('');

      tr.innerHTML = `
        <td class="text-muted">${idx + 1}</td>
        <td>
          <input type="text" class="form-control form-control-sm edit-name" data-idx="${idx}"
                 value="${item.name.replace(/"/g, '&quot;')}">
        </td>
        <td>
          <input type="text" class="form-control form-control-sm edit-barcode" data-idx="${idx}"
                 value="${(item.barcode || '').replace(/"/g, '&quot;')}" placeholder="—" style="width:110px;font-size:0.75rem" inputmode="numeric">
        </td>
        <td>
          <div class="d-flex gap-1 align-items-center">
            <input type="number" class="form-control form-control-sm edit-qty-besar" data-idx="${idx}"
                   value="${item.qtyBesar}" min="0" step="any" style="width:55px">
            <select class="form-select form-select-sm edit-satuan-bsr" data-idx="${idx}" style="width:68px;font-size:0.75rem">
              ${unitOpts}
            </select>
          </div>
        </td>
        <td>
          <input type="number" class="form-control form-control-sm edit-qty-kecil" data-idx="${idx}"
                 value="${item.qtyKecil}" min="0" step="any" style="width:60px">
        </td>
        <td>
          <input type="text" class="form-control form-control-sm edit-price-total text-end" data-idx="${idx}"
                 value="${item.priceTotal ? formatNumber(Math.round(item.priceTotal)) : ''}" placeholder="0" style="width:88px" inputmode="numeric">
        </td>
        <td class="text-end text-muted small harga-bsr" data-idx="${idx}">
          ${item.priceBsr ? formatNumber(Math.round(item.priceBsr)) : '—'}
        </td>
        <td class="text-end text-muted small harga-kcl" data-idx="${idx}">
          ${item.qtyKecil > 0 && item.priceBsr ? formatNumber(Math.round(item.priceBsr / item.qtyKecil)) : '—'}
        </td>
        <td>
          <input type="number" class="form-control form-control-sm edit-disc1 text-end pct-input" data-idx="${idx}"
                 value="${item.disc1 != null ? item.disc1 : ''}" placeholder="—" step="any" min="0" max="100">
        </td>
        <td>
          <input type="number" class="form-control form-control-sm edit-disc2 text-end pct-input" data-idx="${idx}"
                 value="${item.disc2 != null ? item.disc2 : ''}" placeholder="—" step="any" min="0" max="100">
        </td>
        <td>
          <input type="number" class="form-control form-control-sm edit-disc3 text-end pct-input" data-idx="${idx}"
                 value="${item.disc3 != null ? item.disc3 : ''}" placeholder="—" step="any" min="0" max="100">
        </td>
        <td>
          <input type="number" class="form-control form-control-sm edit-ppn text-end pct-input" data-idx="${idx}"
                 value="${item.ppn != null ? item.ppn : ''}" placeholder="—" step="any" min="0" max="100">
        </td>
        <td>${matchHTML}</td>
        <td>
          <button class="btn btn-sm btn-outline-danger btn-remove p-0 px-1" data-idx="${idx}" title="Hapus">
            <i class="bi bi-x"></i>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Bind inline edit fields
    $$('.edit-name').forEach((el) => {
      el.addEventListener('change', () => {
        state.items[parseInt(el.dataset.idx)].name = el.value.trim();
      });
    });
    $$('.edit-barcode').forEach((el) => {
      el.addEventListener('change', () => {
        state.items[parseInt(el.dataset.idx)].barcode = el.value.trim();
      });
    });
    $$('.edit-qty-besar').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        state.items[idx].qtyBesar = parseFloat(el.value) || 0;
        _recalcFromTotal(idx);
      });
    });
    $$('.edit-qty-kecil').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        state.items[idx].qtyKecil = parseFloat(el.value) || 0;
        _recalcFromTotal(idx);
      });
    });
    $$('.edit-satuan-bsr').forEach((el) => {
      el.addEventListener('change', () => {
        state.items[parseInt(el.dataset.idx)].satuanBsr = el.value;
      });
    });
    function _recalcFromTotal(idx) {
      const item = state.items[idx];
      const qty = item.qtyBesar || 1;
      item.priceBsr = qty ? item.priceTotal / qty : item.priceTotal;
      item.priceKcl = item.qtyKecil > 0 ? item.priceBsr / item.qtyKecil : 0;

      const bsrEl = document.querySelector(`.harga-bsr[data-idx="${idx}"]`);
      const kclEl = document.querySelector(`.harga-kcl[data-idx="${idx}"]`);
      if (bsrEl) bsrEl.textContent = item.priceBsr ? formatNumber(Math.round(item.priceBsr)) : '—';
      if (kclEl) kclEl.textContent = item.qtyKecil > 0 && item.priceKcl ? formatNumber(Math.round(item.priceKcl)) : '—';
    }

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
    $$('.edit-disc1').forEach((el) => {
      el.addEventListener('change', () => {
        state.items[parseInt(el.dataset.idx)].disc1 = el.value !== '' ? parseFloat(el.value) : null;
      });
    });
    $$('.edit-disc2').forEach((el) => {
      el.addEventListener('change', () => {
        state.items[parseInt(el.dataset.idx)].disc2 = el.value !== '' ? parseFloat(el.value) : null;
      });
    });
    $$('.edit-disc3').forEach((el) => {
      el.addEventListener('change', () => {
        state.items[parseInt(el.dataset.idx)].disc3 = el.value !== '' ? parseFloat(el.value) : null;
      });
    });
    $$('.edit-ppn').forEach((el) => {
      el.addEventListener('change', () => {
        state.items[parseInt(el.dataset.idx)].ppn = el.value !== '' ? parseFloat(el.value) : null;
      });
    });

    // Bind remove buttons
    $$('.btn-remove').forEach((btn) => {
      btn.addEventListener('click', () => removeItem(parseInt(btn.dataset.idx)));
    });

    // Bind review buttons
    $$('.btn-review').forEach((btn) => {
      btn.addEventListener('click', () => openMatchModal(parseInt(btn.dataset.idx)));
    });

    dom.itemCount.textContent = `${state.items.length} item`;
    dom.btnMatchAll.disabled = false;
    dom.btnClearAll.disabled = false;

    // Enable preview only if all items are matched
    const allMatched = state.items.every((i) => i.status === 'auto' && i.selectedArtno);
    dom.btnPreviewPO.disabled = !allMatched;
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

  async function selectCandidate(match) {
    const idx = state.currentReviewIdx;
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
    // Auto-populate price from match if not yet set
    if (match.hbelibsr && !item.priceTotal) {
      item.priceTotal = match.hbelibsr * (item.qtyBesar || 1);
    }
    // Recalculate derived prices (packing may have changed)
    const qty = item.qtyBesar || 1;
    item.priceBsr = qty ? item.priceTotal / qty : item.priceTotal;
    item.priceKcl = item.priceBsr / (item.packing || 1);

    // Save alias if checkbox checked
    if (dom.chkSaveAlias.checked) {
      try {
        await api('/receipt/save-alias', {
          method: 'POST',
          body: { alias_name: item.name, artno: match.artno, userid: dom.userSelect.value },
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
  async function previewPO() {
    if (!requireHeaderFields()) return;
    const userId = dom.userSelect.value;
    const supplierId = dom.vendorSelect.value;

    const shippingCost = parsePrice(dom.shippingCostInput.value);
    const items = state.items
      .filter((i) => i.selectedArtno)
      .map((i) => ({
        artno: i.selectedArtno,
        qty: computeQty(i),
        price_override: i.priceBsr || 0,
        disc1_override: i.disc1,
        disc2_override: i.disc2,
        disc3_override: i.disc3,
        ppn_override: i.ppn,
      }));

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
      .map((i) => ({
        artno: i.selectedArtno,
        qty: computeQty(i),
        price_override: i.priceBsr || 0,
        disc1_override: i.disc1,
        disc2_override: i.disc2,
        disc3_override: i.disc3,
        ppn_override: i.ppn,
      }));

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
