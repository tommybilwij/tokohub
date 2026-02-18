/**
 * Stock Entry App - Frontend Logic
 * Vanilla JS, no build step.
 */

(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------
  const state = {
    items: [],       // [{name, qty, price, status, matches, selectedArtno}]
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
    itemQtyInput:    $('#itemQtyInput'),
    itemPriceInput:  $('#itemPriceInput'),
    btnAddItem:      $('#btnAddItem'),
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
    return new Intl.NumberFormat('id-ID').format(Math.round(n));
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
        dom.itemNameInput.value = item.artname || '';
        dom.searchResults.classList.add('d-none');
        // Auto-add with the matched item
        addItem(item.artname, parseFloat(dom.itemQtyInput.value) || 1,
                parseFloat(dom.itemPriceInput.value) || 0, 'auto',
                [item], item.artno);
        dom.itemNameInput.value = '';
        dom.itemQtyInput.value = '1';
        dom.itemPriceInput.value = '';
        dom.itemNameInput.focus();
      });

      dom.searchResults.appendChild(el);
    });

    dom.searchResults.classList.remove('d-none');
  }

  // -----------------------------------------------------------------------
  // Item Management
  // -----------------------------------------------------------------------
  function addItemFromInput() {
    const name = dom.itemNameInput.value.trim();
    const qty = parseFloat(dom.itemQtyInput.value) || 1;
    const price = parseFloat(dom.itemPriceInput.value) || 0;

    if (!name) return;

    addItem(name, qty, price);
    dom.itemNameInput.value = '';
    dom.itemQtyInput.value = '1';
    dom.itemPriceInput.value = '';
    dom.itemNameInput.focus();
    dom.searchResults.classList.add('d-none');
  }

  function addItem(name, qty, price, status, matches, selectedArtno) {
    state.items.push({
      name,
      qty,
      price: price || 0,
      status: status || 'unmatched',
      matches: matches || [],
      selectedArtno: selectedArtno || null,
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
        <tr><td colspan="5" class="text-center text-muted py-4">
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
        matchHTML = `<span class="badge badge-auto text-bg-success">${m.artname || m.artno}</span>`;
      } else if (item.status === 'review') {
        matchHTML = `<button class="btn btn-sm btn-warning btn-review" data-idx="${idx}">
          <i class="bi bi-search"></i> Pilih
        </button>`;
      } else {
        matchHTML = `<span class="badge text-bg-danger">Belum match</span>`;
      }

      tr.innerHTML = `
        <td>${idx + 1}</td>
        <td>
          <span>${item.name}</span>
          ${item.price ? `<br><small class="text-muted">@${formatNumber(item.price)}</small>` : ''}
        </td>
        <td>${item.qty}</td>
        <td>${matchHTML}</td>
        <td>
          <button class="btn btn-sm btn-outline-danger btn-remove" data-idx="${idx}">
            <i class="bi bi-x"></i>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
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
  async function matchAllItems() {
    const unmatched = state.items.filter((i) => i.status !== 'auto' || !i.selectedArtno);
    if (unmatched.length === 0) return;

    showSpinner();
    try {
      const payload = state.items.map((i) => ({
        name: i.name,
        qty: i.qty,
        price: i.price,
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
          item.selectedArtno = result.matches[0].artno;
        }
      });

      renderItemTable();
    } catch (e) {
      alert('Match gagal: ' + e.message);
    } finally {
      hideSpinner();
    }
  }

  // -----------------------------------------------------------------------
  // Match Review Modal
  // -----------------------------------------------------------------------
  function openMatchModal(idx) {
    state.currentReviewIdx = idx;
    const item = state.items[idx];

    dom.matchOrigName.textContent = item.name;
    dom.matchCandidates.innerHTML = '';

    if (!item.matches.length) {
      dom.matchCandidates.innerHTML = '<p class="text-muted">Tidak ada kandidat.</p>';
    } else {
      item.matches.forEach((m) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'list-group-item list-group-item-action';

        const scoreClass = m.score >= 80 ? 'score-high' : m.score >= 60 ? 'score-mid' : 'score-low';
        el.innerHTML = `
          <div class="d-flex justify-content-between">
            <div>
              <strong>${m.artname || ''}</strong><br>
              <small class="text-muted">${m.artno} | Barcode: ${m.artpabrik || '-'}</small>
            </div>
            <span class="match-score ${scoreClass}">${m.score}%</span>
          </div>
        `;

        el.addEventListener('click', () => selectCandidate(m));
        dom.matchCandidates.appendChild(el);
      });
    }

    new bootstrap.Modal(dom.matchModal).show();
  }

  async function selectCandidate(match) {
    const idx = state.currentReviewIdx;
    const item = state.items[idx];

    item.selectedArtno = match.artno;
    item.status = 'auto';
    item.matches = [match];

    // Save alias if checkbox checked
    if (dom.chkSaveAlias.checked) {
      try {
        await api('/receipt/save-alias', {
          method: 'POST',
          body: { alias_name: item.name, artno: match.artno },
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
    const file = dom.photoInput.files[0];
    if (!file) { alert('Pilih foto terlebih dahulu.'); return; }

    const formData = new FormData();
    formData.append('photo', file);

    dom.ocrStatus.textContent = 'Memproses OCR...';
    showSpinner();

    try {
      const data = await api('/receipt/upload-photo', { method: 'POST', body: formData });
      (data.items || []).forEach((item) => {
        addItem(item.name, item.qty, item.price);
      });
      dom.ocrStatus.textContent = `${data.items.length} baris terdeteksi.`;
      dom.photoInput.value = '';
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
    const file = dom.csvInput.files[0];
    if (!file) { alert('Pilih file CSV/Excel terlebih dahulu.'); return; }

    const formData = new FormData();
    formData.append('file', file);

    showSpinner();
    try {
      const data = await api('/receipt/upload-csv', { method: 'POST', body: formData });
      (data.items || []).forEach((item) => {
        addItem(item.name, item.qty, item.price);
      });
      dom.csvInput.value = '';
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
    const userId = dom.userSelect.value;
    if (!userId) { alert('Pilih user terlebih dahulu.'); return; }
    const supplierId = dom.vendorSelect.value;
    if (!supplierId) { alert('Pilih supplier terlebih dahulu.'); return; }

    const items = state.items
      .filter((i) => i.selectedArtno)
      .map((i) => ({
        artno: i.selectedArtno,
        qty: i.qty,
        price_override: i.price || 0,
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
        <td class="text-end">${formatNumber(line.hbelinetto)}</td>
        <td class="text-end">${formatNumber(line.amount)}</td>
      `;
      dom.poPreviewBody.appendChild(tr);
    });
  }

  // -----------------------------------------------------------------------
  // PO Commit
  // -----------------------------------------------------------------------
  async function commitPO() {
    if (!confirm('Buat Purchase Order dan update stok?\nAksi ini tidak bisa dibatalkan.')) return;

    const userId = dom.userSelect.value;
    const supplierId = dom.vendorSelect.value;
    const items = state.items
      .filter((i) => i.selectedArtno)
      .map((i) => ({
        artno: i.selectedArtno,
        qty: i.qty,
        price_override: i.price || 0,
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
