/**
 * PO Edit Overlay for Daftar Faktur page.
 * Replicates the Daftar Barang layout from Input Faktur.
 */
(function () {
  'use strict';

  var overlay = document.getElementById('poEditOverlay');
  if (!overlay) return;

  var UNITS = ['CTN','BOX','BAL','DUS','PAK','LSN','KTK','RTG','ZAK','GONI','SAK','KLG','KRAT','PPN','TOP','PAIL','GROS','GROSS','KRT','Pcs'];

  var elTitle = document.getElementById('editTitle');
  var elSupplier = document.getElementById('editSupplier');
  var elDate = document.getElementById('editDate');
  var elUser = document.getElementById('editUser');
  var elBody = document.getElementById('editTableBody');
  var elBtnSave = document.getElementById('editBtnSave');
  var elBtnBack = document.getElementById('editBtnBack');
  var elSearchInput = document.getElementById('editSearchInput');
  var elSearchResults = document.getElementById('editSearchResults');
  var elItemCount = document.getElementById('editItemCount');

  var currentPO = null;
  var editLines = [];
  var vendors = [];

  // ------- Helpers -------
  function fmtNum(n) {
    var v = Number(n);
    if (isNaN(v)) return '0.00';
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function parseNum(s) {
    return parseFloat(String(s).replace(/,/g, '').replace(/[^0-9.\-]/g, '')) || 0;
  }

  function trunc2(n) { return Math.floor(n * 100) / 100; }

  function esc(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function calcNetPrice(hbelibsr, d1, d2, d3, ppn) {
    var disc1 = hbelibsr * (d1 || 0) / 100;
    var afterD1 = hbelibsr - disc1;
    var disc2 = afterD1 * (d2 || 0) / 100;
    var afterD2 = afterD1 - disc2;
    var ppnAmt = afterD2 * (ppn || 0) / 100;
    var afterPPN = afterD2 + ppnAmt;
    var disc3 = afterPPN * (d3 || 0) / 100;
    return { d1: disc1, d2: disc2, d3: disc3, ppnAmt: ppnAmt, final: afterPPN - disc3 };
  }

  function discBase(line, field) {
    var h = line.hbelibsr || 0;
    if (!h) return 0;
    var net = calcNetPrice(h, line.pctdisc1, line.pctdisc2, line.pctdisc3, line.pctppn);
    if (field === 'pctdisc1') return h;
    if (field === 'pctdisc2') return h - net.d1;
    if (field === 'pctppn') return h - net.d1 - net.d2;
    if (field === 'pctdisc3') return h - net.d1 - net.d2 + net.ppnAmt;
    return h;
  }

  // ------- Load dropdowns -------
  async function loadDropdowns() {
    if (!vendors.length) {
      try { vendors = await (await fetch('/api/vendors')).json(); } catch (e) { console.error(e); }
    }
    elSupplier.innerHTML = '<option value="">-- Pilih Supplier --</option>';
    vendors.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.id + ' - ' + (v.name || '');
      elSupplier.appendChild(opt);
    });

    // User is pre-filled from login session (hidden input)
  }

  // ------- Open overlay -------
  async function openEdit(poNumber) {
    await loadDropdowns();

    var res = await fetch('/api/po/' + encodeURIComponent(poNumber));
    var data = await res.json();
    if (data.error) {
      if (window.showToast) window.showToast(data.error, 'danger');
      return;
    }

    currentPO = data;
    elTitle.textContent = 'Edit Faktur: ' + data.noorder;
    elSupplier.value = data.suppid || '';
    elDate.value = data.tglorder || '';
    // elUser is pre-filled from login session

    editLines = (data.lines || []).map(function (l) {
      var b1 = l.bundling1 || {};
      var b2 = l.bundling2 || {};
      return {
        stockid: l.stockid,
        artpabrik: l.artpabrik || '',
        artname: l.artname || '',
        qty: l.qty || 0,
        packing: l.packing || 1,
        satuanbsr: l.satuanbsr || 'CTN',
        satuankcl: l.satuankcl || 'Pcs',
        hbelibsr: l.hbelibsr || 0,
        pctdisc1: l.pctdisc1 || 0,
        pctdisc2: l.pctdisc2 || 0,
        pctdisc3: l.pctdisc3 || 0,
        pctppn: l.pctppn || 0,
        hjual: l.hjual || 0,
        hjual2: l.hjual2 || 0,
        hjual3: l.hjual3 || 0,
        hjual4: l.hjual4 || 0,
        hjual5: l.hjual5 || 0,
        qtybonus: l.qtybonus || 0,
        bkirim: 0,
        bundling1: { enabled: !!(b1.min_qty), minQty: b1.min_qty || 0, hjual1: b1.hjual1 || 0, hjual2: b1.hjual2 || 0, hjual3: b1.hjual3 || 0, hjual4: b1.hjual4 || 0, hjual5: b1.hjual5 || 0 },
        bundling2: { enabled: !!(b2.min_qty), minQty: b2.min_qty || 0, hjual1: b2.hjual1 || 0, hjual2: b2.hjual2 || 0, hjual3: b2.hjual3 || 0, hjual4: b2.hjual4 || 0, hjual5: b2.hjual5 || 0 },
      };
    });

    renderTable();
    overlay.classList.remove('d-none');
    document.body.style.overflow = 'hidden';
  }

  // ------- Close overlay -------
  function closeEdit() {
    overlay.classList.add('d-none');
    document.body.style.overflow = '';
    currentPO = null;
    editLines = [];
    elSearchInput.value = '';
    elSearchResults.classList.add('d-none');
  }

  // ------- Render jual table -------
  function renderJualTable(idx, tier, values) {
    var t = tier == null ? 'main' : tier;
    var dis = tier != null && !values._enabled ? 'disabled' : '';
    var rows = [
      { label: 'Jual 1', field: 'hjual1' },
      { label: 'Member', field: 'hjual2' },
      { label: 'Jual 3', field: 'hjual3' },
      { label: 'Jual 4', field: 'hjual4' },
      { label: 'Jual 5', field: 'hjual5' },
    ];
    var rowsHTML = rows.map(function (r) {
      var val = values[r.field];
      return '<tr>' +
        '<td class="jt-label">' + r.label + '</td>' +
        '<td><input type="text" class="jual-input" data-idx="' + idx + '" data-tier="' + t + '" data-field="' + r.field + '"' +
        ' value="' + (val ? fmtNum(val) : '') + '" placeholder="—" inputmode="decimal" ' + dis + '></td>' +
        '<td class="jt-pct"><input type="text" class="jual-pct-input" data-idx="' + idx + '" data-tier="' + t + '" data-field="' + r.field + '"' +
        ' value="" placeholder="—" inputmode="decimal" ' + dis + '></td>' +
        '<td class="jt-margin"><span class="jual-margin" data-idx="' + idx + '" data-tier="' + t + '" data-field="' + r.field + '">—</span></td>' +
        '</tr>';
    }).join('');
    return '<table class="jual-table"><thead><tr><th></th><th>Harga</th><th>Mrg%</th><th>Margin</th></tr></thead><tbody>' + rowsHTML + '</tbody></table>';
  }

  // ------- Render bundling column -------
  function renderBundlingCol(idx, tier, b) {
    var checked = b.enabled ? 'checked' : '';
    var disabled = b.enabled ? '' : 'disabled';
    var vals = { hjual1: b.hjual1, hjual2: b.hjual2, hjual3: b.hjual3, hjual4: b.hjual4, hjual5: b.hjual5, _enabled: b.enabled };
    return '<div class="dp-jual-col dp-bundling-inline">' +
      '<div class="dp-jual-col-header">' +
        '<label class="bundling-toggle">' +
          '<input type="checkbox" class="form-check-input bundling-enable" data-idx="' + idx + '" data-tier="' + tier + '" ' + checked + '>' +
          ' Bundling ' + tier +
        '</label>' +
        '<span class="bundling-qty-wrap">Qty &ge; ' +
          '<input type="number" class="bundling-minqty" data-idx="' + idx + '" data-tier="' + tier + '"' +
          ' value="' + (b.minQty || '') + '" placeholder="0" min="1" step="0.01" ' + disabled + '> <span style="text-transform:none">Pcs</span>' +
        '</span>' +
      '</div>' +
      '<div class="bundling-fields' + (b.enabled ? '' : ' bundling-fields-disabled') + '" data-idx="' + idx + '" data-tier="' + tier + '">' +
        renderJualTable(idx, tier, vals) +
      '</div>' +
    '</div>';
  }

  // ------- Render full table -------
  function renderTable() {
    elBody.innerHTML = '';

    editLines.forEach(function (line, idx) {
      var sat = line.satuanbsr || 'Bsr';
      var unitOpts = UNITS.map(function (u) {
        return '<option' + (u === line.satuanbsr ? ' selected' : '') + '>' + u + '</option>';
      }).join('');

      // Main row
      var tr = document.createElement('tr');
      tr.className = 'item-main has-detail-open';
      tr.dataset.idx = idx;
      tr.innerHTML =
        '<td class="row-num"><span class="expand-toggle"><i class="bi bi-chevron-right"></i></span> ' + (idx + 1) + '</td>' +
        '<td><input type="text" class="form-control edit-name" data-idx="' + idx + '" value="' + esc(line.artname) + '" readonly style="background:transparent;border:none;cursor:pointer" title="' + esc(line.stockid) + '"></td>' +
        '<td><input type="text" class="form-control" data-idx="' + idx + '" value="' + esc(line.artpabrik) + '" readonly style="background:transparent;border:none" tabindex="-1"></td>' +
        '<td><div class="d-flex gap-1 align-items-center">' +
          '<div class="qty-stepper">' +
            '<button type="button" class="qty-stepper-btn ed-qtybsr-down" data-idx="' + idx + '"><i class="bi bi-dash"></i></button>' +
            '<input type="number" class="form-control edit-qty-besar" data-idx="' + idx + '" value="' + line.qty + '" min="0" step="1">' +
            '<button type="button" class="qty-stepper-btn ed-qtybsr-up" data-idx="' + idx + '"><i class="bi bi-plus"></i></button>' +
          '</div>' +
          '<select class="form-select edit-satuan-bsr w-fixed-72" data-idx="' + idx + '">' + unitOpts + '</select>' +
        '</div></td>' +
        '<td><div class="qty-stepper">' +
          '<button type="button" class="qty-stepper-btn ed-packing-down" data-idx="' + idx + '"><i class="bi bi-dash"></i></button>' +
          '<input type="number" class="form-control edit-packing" data-idx="' + idx + '" value="' + line.packing + '" min="1" step="1">' +
          '<button type="button" class="qty-stepper-btn ed-packing-up" data-idx="' + idx + '"><i class="bi bi-plus"></i></button>' +
        '</div></td>' +
        '<td><input type="text" class="form-control edit-price-total text-end" data-idx="' + idx + '" value="' + (line.hbelibsr * line.qty ? fmtNum(line.hbelibsr * line.qty) : '') + '" inputmode="decimal"></td>' +
        '<td class="text-center"><code>' + esc(line.stockid) + '</code></td>' +
        '<td><button class="btn btn-sm btn-outline-danger btn-remove p-0 px-1" data-idx="' + idx + '" title="Hapus"><i class="bi bi-x-lg"></i></button></td>';
      elBody.appendChild(tr);

      // Detail row
      var net = calcNetPrice(line.hbelibsr, line.pctdisc1, line.pctdisc2, line.pctdisc3, line.pctppn);
      var nettoBsr = net.final + (line.bkirim || 0);
      var nettoPcs = line.packing > 0 ? nettoBsr / line.packing : 0;
      var mainJual = { hjual1: line.hjual, hjual2: line.hjual2, hjual3: line.hjual3, hjual4: line.hjual4, hjual5: line.hjual5, _enabled: true };

      var detailTr = document.createElement('tr');
      detailTr.className = 'item-detail open';
      detailTr.dataset.idx = idx;
      detailTr.innerHTML =
        '<td colspan="8"><div class="dp-grid">' +
          '<div class="dp-section dp-beli">' +
            '<div class="dp-section-header">Harga Beli</div>' +
            '<div class="dp-beli-row">' +
              '<span class="dp-label">Beli</span>' +
              '<span class="dp-val hbeli-bsr" data-idx="' + idx + '">' + (line.hbelibsr ? fmtNum(line.hbelibsr) : '—') + '</span><span class="dp-unit dp-unit-bsr">/' + esc(sat) + '</span>' +
              '<span class="dp-val hbeli-pcs" data-idx="' + idx + '">' + (line.packing > 0 ? fmtNum(trunc2(line.hbelibsr / line.packing)) : '—') + '</span><span class="dp-unit">/Pcs</span>' +
            '</div>' +
            '<table class="beli-table"><thead><tr>' +
              '<th></th>' +
              '<th class="dp-th-total"><span class="dp-unit-bsr">/' + esc(sat) + '</span> &times; <span class="dp-qty-bsr">' + (line.qty || 1) + '</span> =</th>' +
              '<th class="dp-unit-bsr">/' + esc(sat) + '</th>' +
              '<th>%</th>' +
            '</tr></thead><tbody>' +
              _discRow(idx, 'Diskon 1', 'pctdisc1', line) +
              _discRow(idx, 'Diskon 2', 'pctdisc2', line) +
              _discRow(idx, 'PPN', 'pctppn', line) +
              _discRow(idx, 'Diskon 3', 'pctdisc3', line) +
            '</tbody></table>' +
            '<div class="beli-row-foc"><span class="bt-label">F.O.C</span>' +
              '<input type="number" class="amt-input edit-foc" data-idx="' + idx + '" value="' + (line.qtybonus || '') + '" placeholder="0" min="0" step="1">' +
              '<span class="bt-unit">Pcs</span></div>' +
            '<div class="beli-row-shipping"><span class="bt-label">B.Kirim</span>' +
              '<input type="text" class="amt-input edit-bkirim" data-idx="' + idx + '" value="' + (line.bkirim ? fmtNum(line.bkirim) : '') + '" placeholder="0" inputmode="decimal"></div>' +
            '<div class="dp-netto-row">' +
              '<span class="dp-label">Netto</span>' +
              '<span class="dp-netto-val netto-bsr" data-idx="' + idx + '">' + fmtNum(nettoBsr) + '</span><span class="dp-unit dp-unit-bsr">/' + esc(sat) + '</span>' +
              '<span class="dp-netto-val netto-pcs" data-idx="' + idx + '">' + fmtNum(nettoPcs) + '</span><span class="dp-unit">/Pcs</span>' +
            '</div>' +
          '</div>' +
          '<div class="dp-section dp-jual-wrapper">' +
            '<div class="dp-section-header">Harga Jual</div>' +
            '<div class="dp-jual-row">' +
              '<div class="dp-jual-col"><div class="dp-jual-col-header">Satuan</div>' + renderJualTable(idx, null, mainJual) + '</div>' +
              renderBundlingCol(idx, 1, line.bundling1) +
              renderBundlingCol(idx, 2, line.bundling2) +
            '</div>' +
          '</div>' +
        '</div></td>';
      elBody.appendChild(detailTr);
    });

    // Bind events after rendering
    bindTableEvents();
    // Update computed prices (margin displays)
    editLines.forEach(function (_, idx) { updateComputedPrices(idx); });
    elItemCount.textContent = editLines.length + ' item';
  }

  function _discRow(idx, label, field, line) {
    var net = calcNetPrice(line.hbelibsr, line.pctdisc1, line.pctdisc2, line.pctdisc3, line.pctppn);
    var amtMap = { pctdisc1: net.d1, pctdisc2: net.d2, pctdisc3: net.d3, pctppn: net.ppnAmt };
    var amt = amtMap[field] || 0;
    var qtyBsr = line.qty || 1;
    return '<tr>' +
      '<td class="bt-label">' + label + '</td>' +
      '<td><input type="text" class="amt-total edit-disc-total" data-idx="' + idx + '" data-field="' + field + '" value="' + (amt ? fmtNum(amt * qtyBsr) : '') + '" placeholder="0" inputmode="decimal"></td>' +
      '<td><input type="text" class="amt-input edit-disc-amt" data-idx="' + idx + '" data-field="' + field + '" value="' + (amt ? fmtNum(amt) : '') + '" placeholder="0" inputmode="decimal"></td>' +
      '<td><input type="number" class="pct-input edit-disc-pct" data-idx="' + idx + '" data-field="' + field + '" value="' + (line[field] || '') + '" placeholder="—" step="any" min="0" max="100"></td>' +
      '</tr>';
  }

  // ------- Update computed displays -------
  function updateComputedPrices(idx) {
    var line = editLines[idx];
    var h = line.hbelibsr || 0;
    var pk = line.packing || 0;
    var net = calcNetPrice(h, line.pctdisc1, line.pctdisc2, line.pctdisc3, line.pctppn);
    var shipping = line.bkirim || 0;
    var finalBsr = net.final + shipping;
    var nettoPcs = pk > 0 ? finalBsr / pk : 0;

    // Netto
    var nBsr = document.querySelector('.netto-bsr[data-idx="' + idx + '"]');
    var nPcs = document.querySelector('.netto-pcs[data-idx="' + idx + '"]');
    if (nBsr) nBsr.textContent = h ? fmtNum(finalBsr) : '—';
    if (nPcs) nPcs.textContent = (h && pk > 0) ? fmtNum(finalBsr / pk) : '—';

    // Beli
    var bBsr = document.querySelector('.hbeli-bsr[data-idx="' + idx + '"]');
    var bPcs = document.querySelector('.hbeli-pcs[data-idx="' + idx + '"]');
    if (bBsr) bBsr.textContent = h ? fmtNum(h) : '—';
    if (bPcs) bPcs.textContent = (h && pk > 0) ? fmtNum(trunc2(h / pk)) : '—';

    // Disc amounts
    var qtyBsr = line.qty || 1;
    var amtMap = { pctdisc1: net.d1, pctdisc2: net.d2, pctdisc3: net.d3, pctppn: net.ppnAmt };
    ['pctdisc1','pctdisc2','pctdisc3','pctppn'].forEach(function (f) {
      var amtEl = document.querySelector('.edit-disc-amt[data-idx="' + idx + '"][data-field="' + f + '"]');
      if (amtEl && document.activeElement !== amtEl) amtEl.value = amtMap[f] ? fmtNum(amtMap[f]) : '';
      var totEl = document.querySelector('.edit-disc-total[data-idx="' + idx + '"][data-field="' + f + '"]');
      if (totEl && document.activeElement !== totEl) totEl.value = amtMap[f] ? fmtNum(amtMap[f] * qtyBsr) : '';
    });

    // Jual margins — main + bundling tiers
    ['main', '1', '2'].forEach(function (tier) {
      ['hjual1','hjual2','hjual3','hjual4','hjual5'].forEach(function (f) {
        var val;
        if (tier === 'main') {
          val = f === 'hjual1' ? line.hjual : line[f];
        } else {
          var bkey = 'bundling' + tier;
          val = line[bkey] ? line[bkey][f] : 0;
        }
        var pctEl = document.querySelector('.jual-pct-input[data-idx="' + idx + '"][data-tier="' + tier + '"][data-field="' + f + '"]');
        var mrgEl = document.querySelector('.jual-margin[data-idx="' + idx + '"][data-tier="' + tier + '"][data-field="' + f + '"]');
        if (!pctEl || !mrgEl) return;
        if (!val || !nettoPcs) {
          if (document.activeElement !== pctEl) pctEl.value = '';
          mrgEl.textContent = '—';
          return;
        }
        var margin = val - nettoPcs;
        var pct = (margin / nettoPcs) * 100;
        if (document.activeElement !== pctEl) pctEl.value = pct.toFixed(2);
        mrgEl.textContent = margin < 0 ? '-' + fmtNum(Math.abs(margin)) : fmtNum(margin);
        pctEl.classList.toggle('negative', margin < 0);
        mrgEl.classList.toggle('negative', margin < 0);
      });
    });
  }

  // ------- Bind table events -------
  function bindTableEvents() {
    var table = document.getElementById('editItemTable');

    // Toggle detail row
    table.querySelectorAll('.item-main').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.closest('input, button, select')) return;
        var idx = row.dataset.idx;
        var detail = table.querySelector('.item-detail[data-idx="' + idx + '"]');
        if (detail) {
          detail.classList.toggle('open');
          row.classList.toggle('has-detail-open');
        }
      });
    });

    // Qty Besar
    table.querySelectorAll('.edit-qty-besar').forEach(function (el) {
      el.addEventListener('change', function () {
        var idx = parseInt(el.dataset.idx);
        editLines[idx].qty = parseFloat(el.value) || 0;
        recalcLine(idx);
      });
    });
    table.querySelectorAll('.ed-qtybsr-up').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.dataset.idx);
        editLines[idx].qty = (editLines[idx].qty || 0) + 1;
        btn.parentElement.querySelector('.edit-qty-besar').value = editLines[idx].qty;
        recalcLine(idx);
      });
    });
    table.querySelectorAll('.ed-qtybsr-down').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.dataset.idx);
        if (editLines[idx].qty <= 0) return;
        editLines[idx].qty -= 1;
        btn.parentElement.querySelector('.edit-qty-besar').value = editLines[idx].qty;
        recalcLine(idx);
      });
    });

    // Packing
    table.querySelectorAll('.edit-packing').forEach(function (el) {
      el.addEventListener('change', function () {
        var idx = parseInt(el.dataset.idx);
        editLines[idx].packing = parseFloat(el.value) || 1;
        recalcLine(idx);
      });
    });
    table.querySelectorAll('.ed-packing-up').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.dataset.idx);
        editLines[idx].packing = (editLines[idx].packing || 0) + 1;
        btn.parentElement.querySelector('.edit-packing').value = editLines[idx].packing;
        recalcLine(idx);
      });
    });
    table.querySelectorAll('.ed-packing-down').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.dataset.idx);
        if (editLines[idx].packing <= 1) return;
        editLines[idx].packing -= 1;
        btn.parentElement.querySelector('.edit-packing').value = editLines[idx].packing;
        recalcLine(idx);
      });
    });

    // Satuan
    table.querySelectorAll('.edit-satuan-bsr').forEach(function (el) {
      el.addEventListener('change', function () {
        var idx = parseInt(el.dataset.idx);
        editLines[idx].satuanbsr = el.value;
        // Update labels
        var detail = table.querySelector('.item-detail[data-idx="' + idx + '"]');
        if (detail) {
          detail.querySelectorAll('.dp-unit-bsr').forEach(function (s) { s.textContent = '/' + el.value; });
        }
        updateComputedPrices(idx);
      });
    });

    // Total Harga
    table.querySelectorAll('.edit-price-total').forEach(function (el) {
      el.addEventListener('change', function () {
        var idx = parseInt(el.dataset.idx);
        var total = parseNum(el.value);
        var qty = editLines[idx].qty || 1;
        editLines[idx].hbelibsr = qty > 0 ? total / qty : total;
        el.value = total ? fmtNum(total) : '';
        recalcLine(idx);
      });
    });

    // Disc percent
    table.querySelectorAll('.edit-disc-pct').forEach(function (el) {
      function handler() {
        var idx = parseInt(el.dataset.idx);
        var field = el.dataset.field;
        editLines[idx][field] = el.value !== '' ? parseFloat(el.value) : 0;
        updateComputedPrices(idx);
      }
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    });

    // Disc amount → convert to %
    table.querySelectorAll('.edit-disc-amt').forEach(function (el) {
      function handler() {
        var idx = parseInt(el.dataset.idx);
        var field = el.dataset.field;
        var amt = parseNum(el.value);
        var base = discBase(editLines[idx], field);
        editLines[idx][field] = base > 0 ? Math.round((amt / base) * 1000000) / 10000 : 0;
        var pctEl = document.querySelector('.edit-disc-pct[data-idx="' + idx + '"][data-field="' + field + '"]');
        if (pctEl) pctEl.value = editLines[idx][field] || '';
        updateComputedPrices(idx);
      }
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
      el.addEventListener('blur', function () {
        var v = parseNum(el.value);
        el.value = v ? fmtNum(v) : '';
      });
    });

    // Disc total → convert to per-unit then %
    table.querySelectorAll('.edit-disc-total').forEach(function (el) {
      function handler() {
        var idx = parseInt(el.dataset.idx);
        var field = el.dataset.field;
        var totalAmt = parseNum(el.value);
        var qtyBsr = editLines[idx].qty || 1;
        var perUnit = totalAmt / qtyBsr;
        var base = discBase(editLines[idx], field);
        editLines[idx][field] = base > 0 ? Math.round((perUnit / base) * 1000000) / 10000 : 0;
        var pctEl = document.querySelector('.edit-disc-pct[data-idx="' + idx + '"][data-field="' + field + '"]');
        if (pctEl) pctEl.value = editLines[idx][field] || '';
        updateComputedPrices(idx);
      }
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
      el.addEventListener('blur', function () {
        var v = parseNum(el.value);
        el.value = v ? fmtNum(v) : '';
      });
    });

    // FOC
    table.querySelectorAll('.edit-foc').forEach(function (el) {
      el.addEventListener('change', function () {
        editLines[parseInt(el.dataset.idx)].qtybonus = parseInt(el.value) || 0;
      });
    });

    // B.Kirim
    table.querySelectorAll('.edit-bkirim').forEach(function (el) {
      el.addEventListener('change', function () {
        var idx = parseInt(el.dataset.idx);
        editLines[idx].bkirim = parseNum(el.value);
        el.value = editLines[idx].bkirim ? fmtNum(editLines[idx].bkirim) : '';
        updateComputedPrices(idx);
      });
    });

    // Jual price input
    table.querySelectorAll('.jual-input').forEach(function (el) {
      el.addEventListener('change', function () {
        var idx = parseInt(el.dataset.idx);
        var field = el.dataset.field;
        var tier = el.dataset.tier;
        var val = parseNum(el.value);
        var line = editLines[idx];
        if (tier === 'main') {
          if (field === 'hjual1') line.hjual = val || 0;
          else line[field] = val || 0;
        } else {
          var bkey = 'bundling' + tier;
          if (line[bkey]) line[bkey][field] = val || 0;
        }
        el.value = val ? fmtNum(val) : '';
        updateComputedPrices(idx);
      });
    });

    // Jual MRG% input → calc hjual from margin percentage
    table.querySelectorAll('.jual-pct-input').forEach(function (el) {
      el.addEventListener('change', function () {
        var idx = parseInt(el.dataset.idx);
        var field = el.dataset.field;
        var tier = el.dataset.tier;
        var pctVal = parseFloat(el.value.replace(',', '.'));
        var line = editLines[idx];
        var net = calcNetPrice(line.hbelibsr || 0, line.pctdisc1, line.pctdisc2, line.pctdisc3, line.pctppn);
        var shipping = line.bkirim || 0;
        var nettoPcs = line.packing > 0 ? (net.final + shipping) / line.packing : 0;
        if (!nettoPcs) return;
        var hjual = isNaN(pctVal) ? 0 : nettoPcs * (1 + pctVal / 100);
        if (tier === 'main') {
          if (field === 'hjual1') line.hjual = hjual;
          else line[field] = hjual;
        } else {
          var bkey = 'bundling' + tier;
          if (line[bkey]) line[bkey][field] = hjual;
        }
        var hEl = document.querySelector('.jual-input[data-idx="' + idx + '"][data-tier="' + tier + '"][data-field="' + field + '"]');
        if (hEl) hEl.value = hjual ? fmtNum(hjual) : '';
        updateComputedPrices(idx);
      });
    });

    // Bundling enable checkbox
    table.querySelectorAll('.bundling-enable').forEach(function (el) {
      el.addEventListener('change', function () {
        var idx = parseInt(el.dataset.idx);
        var tier = el.dataset.tier;
        var bkey = 'bundling' + tier;
        var line = editLines[idx];
        line[bkey].enabled = el.checked;
        // Enable/disable min qty input
        var mqEl = table.querySelector('.bundling-minqty[data-idx="' + idx + '"][data-tier="' + tier + '"]');
        if (mqEl) mqEl.disabled = !el.checked;
        // Enable/disable jual fields
        var fieldsWrap = table.querySelector('.bundling-fields[data-idx="' + idx + '"][data-tier="' + tier + '"]');
        if (fieldsWrap) {
          fieldsWrap.classList.toggle('bundling-fields-disabled', !el.checked);
          fieldsWrap.querySelectorAll('input').forEach(function (inp) { inp.disabled = !el.checked; });
        }
        if (!el.checked) {
          line[bkey].minQty = 0;
          line[bkey].hjual1 = 0; line[bkey].hjual2 = 0; line[bkey].hjual3 = 0;
          line[bkey].hjual4 = 0; line[bkey].hjual5 = 0;
          if (mqEl) mqEl.value = '';
          if (fieldsWrap) fieldsWrap.querySelectorAll('.jual-input').forEach(function (inp) { inp.value = ''; });
        }
        updateComputedPrices(idx);
      });
    });

    // Bundling min qty
    table.querySelectorAll('.bundling-minqty').forEach(function (el) {
      el.addEventListener('change', function () {
        var idx = parseInt(el.dataset.idx);
        var tier = el.dataset.tier;
        editLines[idx]['bundling' + tier].minQty = parseFloat(el.value) || 0;
      });
    });

    // Remove item
    table.querySelectorAll('.btn-remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        editLines.splice(parseInt(btn.dataset.idx), 1);
        renderTable();
      });
    });
  }

  function recalcLine(idx) {
    var line = editLines[idx];
    // Update labels
    var detail = document.querySelector('#editItemTable .item-detail[data-idx="' + idx + '"]');
    if (detail) {
      detail.querySelectorAll('.dp-qty-bsr').forEach(function (s) { s.textContent = line.qty || 1; });
    }
    updateComputedPrices(idx);
  }

  // ------- Add item search -------
  var searchTimer = null;
  elSearchInput.addEventListener('input', function () {
    clearTimeout(searchTimer);
    var q = elSearchInput.value.trim();
    if (q.length < 2) { elSearchResults.classList.add('d-none'); return; }
    searchTimer = setTimeout(async function () {
      try {
        var results = await (await fetch('/api/stock/search?q=' + encodeURIComponent(q) + '&limit=5')).json();
        showSearchResults(results);
      } catch (e) { console.error(e); }
    }, 300);
  });

  function showSearchResults(results) {
    elSearchResults.innerHTML = '';
    if (!results.length) { elSearchResults.classList.add('d-none'); return; }
    results.forEach(function (item) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'list-group-item list-group-item-action py-1';
      btn.innerHTML = '<div class="d-flex justify-content-between"><span>' + esc(item.artname) + '</span><small class="text-muted">' + (item.score || 0) + '%</small></div>' +
        '<small class="text-muted">' + esc(item.artno) + ' | ' + esc(item.artpabrik || '') + '</small>';
      btn.addEventListener('click', function () {
        addLineFromStock(item);
        elSearchInput.value = '';
        elSearchResults.classList.add('d-none');
      });
      elSearchResults.appendChild(btn);
    });
    elSearchResults.classList.remove('d-none');
  }

  function addLineFromStock(item) {
    var bndl = item._bundlings || [];
    var db1 = bndl[0] || {};
    var db2 = bndl[1] || {};
    editLines.push({
      stockid: item.artno,
      artpabrik: item.artpabrik || '',
      artname: item.artname || '',
      qty: 1,
      packing: parseFloat(item.packing) || 1,
      satuanbsr: item.satbesar || 'CTN',
      satuankcl: item.satkecil || 'Pcs',
      hbelibsr: parseFloat(item.hbelibsr) || 0,
      pctdisc1: parseFloat(item.pctdisc1) || 0,
      pctdisc2: parseFloat(item.pctdisc2) || 0,
      pctdisc3: parseFloat(item.pctdisc3) || 0,
      pctppn: parseFloat(item.pctppn) || 0,
      hjual: parseFloat(item.hjual) || 0,
      hjual2: parseFloat(item.hjual2) || 0,
      hjual3: parseFloat(item.hjual3) || 0,
      hjual4: parseFloat(item.hjual4) || 0,
      hjual5: parseFloat(item.hjual5) || 0,
      qtybonus: 0,
      bkirim: 0,
      bundling1: { enabled: !!(db1.qty), minQty: db1.qty || 0, hjual1: db1.hjual1 || 0, hjual2: db1.hjual2 || 0, hjual3: db1.hjual3 || 0, hjual4: db1.hjual4 || 0, hjual5: db1.hjual5 || 0 },
      bundling2: { enabled: !!(db2.qty), minQty: db2.qty || 0, hjual1: db2.hjual1 || 0, hjual2: db2.hjual2 || 0, hjual3: db2.hjual3 || 0, hjual4: db2.hjual4 || 0, hjual5: db2.hjual5 || 0 },
    });
    renderTable();
  }

  document.addEventListener('click', function (e) {
    if (!elSearchResults.contains(e.target) && e.target !== elSearchInput) {
      elSearchResults.classList.add('d-none');
    }
  });

  elSearchInput.addEventListener('keydown', async function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var q = elSearchInput.value.trim();
    if (!q) return;
    try {
      var results = await (await fetch('/api/stock/search?q=' + encodeURIComponent(q) + '&limit=5')).json();
      if (results.length && results[0].score >= 100) {
        addLineFromStock(results[0]);
        elSearchInput.value = '';
        elSearchResults.classList.add('d-none');
      }
    } catch (e2) { console.warn(e2); }
  });

  // ------- Save -------
  elBtnSave.addEventListener('click', async function () {
    if (!elSupplier.value) { if (window.showToast) window.showToast('Pilih supplier', 'warning'); return; }
    if (!elUser.value) { if (window.showToast) window.showToast('Pilih user', 'warning'); return; }
    if (!elDate.value) { if (window.showToast) window.showToast('Isi tanggal', 'warning'); return; }
    if (!editLines.length) { if (window.showToast) window.showToast('Tidak ada item', 'warning'); return; }

    var ok = window.showConfirm
      ? await window.showConfirm('Update faktur ' + currentPO.noorder + ' dan update stok?')
      : confirm('Update faktur ' + currentPO.noorder + ' dan update stok?');
    if (!ok) return;

    var items = editLines.map(function (l) {
      return {
        artno: l.stockid,
        qty: l.qty,
        price_override: l.hbelibsr,
        packing_override: l.packing,
        disc1_override: l.pctdisc1 || null,
        disc2_override: l.pctdisc2 || null,
        disc3_override: l.pctdisc3 || null,
        ppn_override: l.pctppn || null,
        hjual1_override: l.hjual || null,
        hjual2_override: l.hjual2 || null,
        hjual3_override: l.hjual3 || null,
        hjual4_override: l.hjual4 || null,
        hjual5_override: l.hjual5 || null,
        satuan_bsr: l.satuanbsr,
        foc: l.qtybonus || 0,
        qty_besar: l.qty,
        shipping_cost: l.bkirim || 0,
        bundling1: l.bundling1.enabled ? {
          min_qty: l.bundling1.minQty || 0,
          hjual1: l.bundling1.hjual1 || 0, hjual2: l.bundling1.hjual2 || 0,
          hjual3: l.bundling1.hjual3 || 0, hjual4: l.bundling1.hjual4 || 0,
          hjual5: l.bundling1.hjual5 || 0,
        } : null,
        bundling2: l.bundling2.enabled ? {
          min_qty: l.bundling2.minQty || 0,
          hjual1: l.bundling2.hjual1 || 0, hjual2: l.bundling2.hjual2 || 0,
          hjual3: l.bundling2.hjual3 || 0, hjual4: l.bundling2.hjual4 || 0,
          hjual5: l.bundling2.hjual5 || 0,
        } : null,
      };
    });

    elBtnSave.disabled = true;
    elBtnSave.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Menyimpan...';

    try {
      var res = await fetch('/receipt/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          po_number: currentPO.noorder,
          supplier_id: elSupplier.value,
          userid: elUser.value,
          items: items,
          order_date: elDate.value,
        }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);

      if (window.showToast) window.showToast('Faktur ' + currentPO.noorder + ' berhasil diupdate (' + data.line_count + ' item)', 'success');
      closeEdit();
      window.location.reload();
    } catch (err) {
      if (window.showToast) window.showToast('Update gagal: ' + err.message, 'danger');
    } finally {
      elBtnSave.disabled = false;
      elBtnSave.innerHTML = '<i class="bi bi-check-lg"></i> Simpan';
    }
  });

  // ------- Back / Escape -------
  elBtnBack.addEventListener('click', closeEdit);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !overlay.classList.contains('d-none')) {
      // Don't close if a modal is open
      if (document.querySelector('.modal.show')) return;
      closeEdit();
    }
  });

  // ------- Wire up edit buttons -------
  document.querySelectorAll('.btn-edit-po').forEach(function (btn) {
    btn.addEventListener('click', function () {
      openEdit(btn.dataset.po);
    });
  });
})();
