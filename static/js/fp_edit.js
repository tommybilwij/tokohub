/**
 * FP Edit Overlay for Faktur Pembelian page.
 * Replicates the Daftar Barang layout from Input Faktur.
 */
(function () {
  'use strict';

  var overlay = document.getElementById('fpEditOverlay');
  if (!overlay) return;

  var UNITS = ['CTN','BOX','BAL','DUS','PAK','LSN','KTK','RTG','ZAK','GONI','SAK','KLG','KRAT','PPN','TOP','PAIL','GROS','GROSS','KRT','Pcs'];

  var elTitle = document.getElementById('editTitle');
  var elSupplier = document.getElementById('editSupplier');
  var elSuppInput = document.getElementById('editSuppInput');
  var elSuppMenu = document.getElementById('editSuppMenu');
  var elDate = document.getElementById('editDate');
  var elUser = document.getElementById('editUser');
  var elBody = document.getElementById('editTableBody');
  var elBtnSave = document.getElementById('editBtnSave');
  var elBtnBack = document.getElementById('editBtnBack');
  var elSearchInput = document.getElementById('editSearchInput');
  var elSearchResults = document.getElementById('editSearchResults');
  var elItemCount = document.getElementById('editItemCount');
  var elUpdatePrice = document.getElementById('editUpdatePrice');

  var currentFP = null;
  var editLines = [];
  var vendors = [];
  var beforePrices = {}; // snapshot "before" prices keyed by artno (stok sebelum input faktur)
  var afterPrices = {};  // snapshot "after" prices keyed by artno (values submitted in input faktur)

  // ------- Helpers -------
  function fmtNum(n) {
    var v = Number(n);
    if (isNaN(v)) return '0,00';
    return v.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function parseNum(s) {
    return parseFloat(String(s).replace(/\./g, '').replace(',', '.').replace(/[^0-9.\-]/g, '')) || 0;
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

  // Show "sebelum" hint — always show when snapshot data exists (value on top, no prefix)
  function sblmHint(stockVal) {
    if (stockVal == null || stockVal === undefined) return '';
    var sv = Number(stockVal) || 0;
    return '<div class="sblm-hint">' + (sv ? fmtNum(sv) : '—') + '</div>';
  }

  function sblmPctHint(stockVal) {
    if (stockVal == null || stockVal === undefined) return '';
    var sv = Number(stockVal) || 0;
    return '<div class="sblm-hint">' + (sv ? sv : '—') + '</div>';
  }

  // CSS class for changed values — compare formatted display to avoid float noise
  function changedCls(stockVal, editVal) {
    if (stockVal == null || stockVal === undefined) return '';
    return fmtNum(Number(stockVal) || 0) !== fmtNum(Number(editVal) || 0) ? ' value-changed' : '';
  }

  // ------- Load dropdowns -------
  async function loadDropdowns() {
    if (!vendors.length) {
      try { vendors = await (await fetch('/api/vendors')).json(); } catch (e) { console.error(e); }
    }
  }

  // ------- Searchable supplier dropdown for edit -------
  var editSuppSelected = '';
  function renderEditSuppMenu(filter) {
    var q = (filter || '').toLowerCase();
    var items = vendors.filter(function(v) {
      var label = v.id + ' - ' + (v.name || '');
      return !q || label.toLowerCase().indexOf(q) >= 0;
    });
    elSuppMenu.innerHTML = '';
    items.slice(0, 50).forEach(function(v) {
      var div = document.createElement('div');
      div.className = 'h-supp-item';
      div.textContent = v.id + ' - ' + (v.name || '');
      div.addEventListener('mousedown', function(e) {
        e.preventDefault();
        elSupplier.value = v.id;
        elSuppInput.value = v.id + ' - ' + (v.name || '');
        editSuppSelected = elSuppInput.value;
        elSuppMenu.classList.add('d-none');
      });
      elSuppMenu.appendChild(div);
    });
    elSuppMenu.classList.remove('d-none');
  }
  function setEditSupplier(suppid) {
    elSupplier.value = suppid || '';
    var v = vendors.find(function(x) { return x.id === suppid; });
    elSuppInput.value = v ? (v.id + ' - ' + (v.name || '')) : (suppid || '');
    editSuppSelected = elSuppInput.value;
  }
  elSuppInput.addEventListener('focus', function() {
    editSuppSelected = elSuppInput.value;
    elSuppInput.value = '';
    renderEditSuppMenu('');
  });
  elSuppInput.addEventListener('input', function() { renderEditSuppMenu(elSuppInput.value); });
  elSuppInput.addEventListener('blur', function() {
    elSuppMenu.classList.add('d-none');
    if (!elSuppInput.value && editSuppSelected) elSuppInput.value = editSuppSelected;
  });
  elSuppInput.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { elSuppMenu.classList.add('d-none'); elSuppInput.blur(); }
  });

  // ------- Fetch snapshot data -------
  async function fetchSnapshot(fpNumber) {
    try {
      var res = await fetch('/api/fp/' + encodeURIComponent(fpNumber) + '/snapshot');
      if (!res.ok) return { before: {}, after: {} };
      var data = await res.json();
      var bmap = {}, amap = {};
      (data.items || []).forEach(function (item) {
        if (item.before) bmap[item.artno] = item.before;
        if (item.after) amap[item.artno] = item.after;
      });
      return { before: bmap, after: amap };
    } catch (e) {
      console.error('Failed to fetch snapshot', e);
      return { before: {}, after: {} };
    }
  }

  // ------- Open overlay -------
  async function openEdit(fpNumber) {
    await loadDropdowns();

    var res = await fetch('/api/fp/' + encodeURIComponent(fpNumber));
    var data = await res.json();
    if (data.error) {
      if (window.showToast) window.showToast(data.error, 'danger');
      return;
    }

    currentFP = data;
    elTitle.textContent = 'Edit Faktur Pembelian: ' + data.nofaktur;
    setEditSupplier(data.suppid || '');
    elDate.value = data.tglfaktur || '';
    if (elUpdatePrice) elUpdatePrice.checked = !!data.isupdateprice;

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

    // Fetch snapshot data for comparison
    var snap = await fetchSnapshot(fpNumber);
    beforePrices = snap.before;
    afterPrices = snap.after;

    // Backfill bkirim from snapshot after data (not stored in sthist)
    editLines.forEach(function (line) {
      var af = afterPrices[line.stockid];
      if (af && af.shipping_cost) line.bkirim = af.shipping_cost;
    });

    renderTable();
    overlay.classList.remove('d-none');
    var mainContent = document.querySelector('.sh-page');
    if (mainContent) mainContent.classList.add('d-none');
  }

  // ------- Close overlay -------
  function closeEdit() {
    overlay.classList.add('d-none');
    var mainContent = document.querySelector('.sh-page');
    if (mainContent) mainContent.classList.remove('d-none');
    currentFP = null;
    editLines = [];
    beforePrices = {};
    afterPrices = {};
    elSearchInput.value = '';
    elSearchResults.classList.add('d-none');
  }

  // ------- Render jual table -------
  // Bundling stock field mapping: tier 1 -> hjualo1/hjual2o1/..., tier 2 -> hjualo2/hjual2o2/...
  var _bundlingStockMap = {
    1: { hjual1: 'hjualo1', hjual2: 'hjual2o1', hjual3: 'hjual3o1', hjual4: 'hjual4o1', hjual5: 'hjual5o1' },
    2: { hjual1: 'hjualo2', hjual2: 'hjual2o2', hjual3: 'hjual3o2', hjual4: 'hjual4o2', hjual5: 'hjual5o2' },
  };

  function renderJualTable(idx, tier, values) {
    var t = tier == null ? 'main' : tier;
    var dis = tier != null && !values._enabled ? 'disabled' : '';
    var line = editLines[idx];
    var stk = beforePrices[line.stockid] || {};
    var rows = [
      { label: 'Jual 1', field: 'hjual1', stockField: 'hjual' },
      { label: 'Member', field: 'hjual2', stockField: 'hjual2' },
      { label: 'Jual 3', field: 'hjual3', stockField: 'hjual3' },
      { label: 'Jual 4', field: 'hjual4', stockField: 'hjual4' },
      { label: 'Jual 5', field: 'hjual5', stockField: 'hjual5' },
    ];

    // Calculate stok sblm netto/pcs for margin hints
    var stkNettoPcs = null;
    if (stk.hbelibsr != null) {
      var stkNet = calcNetPrice(stk.hbelibsr || 0, stk.pctdisc1 || 0, stk.pctdisc2 || 0, stk.pctdisc3 || 0, stk.pctppn || 0);
      var stkPk = stk.packing || 1;
      stkNettoPcs = stkPk > 0 ? stkNet.final / stkPk : 0;
    }

    // Current netto/pcs for margin comparison
    var curNet = calcNetPrice(line.hbelibsr || 0, line.pctdisc1 || 0, line.pctdisc2 || 0, line.pctdisc3 || 0, line.pctppn || 0);
    var curNettoPcs = line.packing > 0 ? (curNet.final + (line.bkirim || 0)) / line.packing : 0;

    var rowsHTML = rows.map(function (r) {
      var val = values[r.field];
      var stkVal;
      if (tier == null) {
        stkVal = stk[r.stockField];
      } else {
        var bmap = _bundlingStockMap[tier];
        stkVal = bmap ? stk[bmap[r.field]] : null;
      }
      var cls = changedCls(stkVal, val);
      var hint = sblmHint(stkVal);
      // Margin/MRG% hints from stok sblm
      var mrgHint = '', pctHint = '', pctCls = '', mrgCls = '';
      if (stkVal != null && stkNettoPcs) {
        var sv = Number(stkVal) || 0;
        if (sv) {
          var stkMargin = sv - stkNettoPcs;
          var stkPct = (stkMargin / stkNettoPcs) * 100;
          pctHint = '<div class="sblm-hint">' + stkPct.toFixed(2) + '</div>';
          mrgHint = '<div class="sblm-hint">' + (sv ? fmtNum(stkMargin) : '—') + '</div>';
          // Compare with current margin
          var curVal = Number(val) || 0;
          if (curNettoPcs && curVal) {
            var curMargin = curVal - curNettoPcs;
            var curPct = (curMargin / curNettoPcs) * 100;
            pctCls = changedCls(stkPct, curPct);
            mrgCls = changedCls(stkMargin, curMargin);
          } else {
            pctCls = ' value-changed';
            mrgCls = ' value-changed';
          }
        } else {
          pctHint = '<div class="sblm-hint">—</div>';
          mrgHint = '<div class="sblm-hint">—</div>';
          var curVal2 = Number(val) || 0;
          if (curVal2) { pctCls = ' value-changed'; mrgCls = ' value-changed'; }
        }
      }
      return '<tr>' +
        '<td class="jt-label">' + r.label + '</td>' +
        '<td>' + hint + '<input type="text" class="jual-input' + cls + '" data-idx="' + idx + '" data-tier="' + t + '" data-field="' + r.field + '"' +
        ' value="' + (val ? fmtNum(val) : '') + '" placeholder="—" inputmode="decimal" ' + dis + '></td>' +
        '<td class="jt-pct">' + pctHint + '<input type="text" class="jual-pct-input' + pctCls + '" data-idx="' + idx + '" data-tier="' + t + '" data-field="' + r.field + '"' +
        ' value="" placeholder="—" inputmode="decimal" ' + dis + '></td>' +
        '<td class="jt-margin">' + mrgHint + '<span class="jual-margin' + mrgCls + '" data-idx="' + idx + '" data-tier="' + t + '" data-field="' + r.field + '">—</span></td>' +
        '</tr>';
    }).join('');
    return '<table class="jual-table"><thead><tr><th></th><th>Harga</th><th>Mrg%</th><th>Margin</th></tr></thead><tbody>' + rowsHTML + '</tbody></table>';
  }

  // ------- Render bundling column -------
  function renderBundlingCol(idx, tier, b) {
    var checked = b.enabled ? 'checked' : '';
    var disabled = b.enabled ? '' : 'disabled';
    var vals = { hjual1: b.hjual1, hjual2: b.hjual2, hjual3: b.hjual3, hjual4: b.hjual4, hjual5: b.hjual5, _enabled: b.enabled };
    var stk = beforePrices[editLines[idx].stockid] || {};
    var overField = tier === 1 ? 'over1' : 'over2';
    var stkOver = stk[overField];
    return '<div class="dp-jual-col dp-bundling-inline">' +
      '<div class="dp-jual-col-header">' +
        '<label class="bundling-toggle">' +
          '<input type="checkbox" class="form-check-input bundling-enable" data-idx="' + idx + '" data-tier="' + tier + '" ' + checked + '>' +
          ' Bundling ' + tier +
        '</label>' +
        '<span class="bundling-qty-wrap">Qty &ge; ' +
          '<input type="number" class="bundling-minqty' + (stkOver != null ? changedCls(stkOver, b.minQty) : '') + '" data-idx="' + idx + '" data-tier="' + tier + '"' +
          ' value="' + (b.minQty || '') + '" placeholder="0" min="1" step="0.01" ' + disabled + '> <span style="text-transform:none">Pcs</span>' +
          (stkOver != null ? ' <span class="sblm-right">' + (Number(stkOver) ? stkOver + ' Pcs' : '—') + '</span>' : '') +
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
      var stk = beforePrices[line.stockid] || {};
      var aft = afterPrices[line.stockid] || {};
      var unitOpts = UNITS.map(function (u) {
        return '<option' + (u === line.satuanbsr ? ' selected' : '') + '>' + u + '</option>';
      }).join('');

      // Price change indicator on main row
      var hasChanges = false;
      if (stk.hbelibsr != null || stk.hjual != null || stk.packing != null) {
        var diff = function(a, b) { return Math.abs((Number(a) || 0) - (Number(b) || 0)) >= 0.001; };
        var fields = ['packing', 'hbelibsr', 'pctdisc1', 'pctdisc2', 'pctdisc3', 'pctppn', 'hjual', 'hjual2', 'hjual3', 'hjual4', 'hjual5'];
        fields.forEach(function(f) { if (diff(stk[f], line[f])) hasChanges = true; });
      }
      var changeIcon = hasChanges
        ? ' <span class="badge bg-warning text-dark" style="font-size:0.7em;vertical-align:middle"><i class="bi bi-exclamation-triangle-fill"></i> Berubah</span>'
        : '';

      // Main row
      var tr = document.createElement('tr');
      tr.className = 'item-main';
      tr.dataset.idx = idx;
      tr.innerHTML =
        '<td class="row-num"><span class="expand-toggle"><i class="bi bi-chevron-right"></i></span> ' + (idx + 1) + '</td>' +
        '<td><div><strong>' + esc(line.artname) + '</strong>' + changeIcon + '</div>' +
          '<small class="text-muted"><code>' + esc(line.stockid) + '</code> &middot; ' + esc(sat) + ' (' + line.packing + ')</small></td>' +
        '<td><code>' + esc(line.artpabrik) + '</code></td>' +
        '<td><button class="btn btn-sm btn-outline-danger btn-remove p-0 px-1" data-idx="' + idx + '" title="Hapus"><i class="bi bi-x-lg"></i></button></td>';
      elBody.appendChild(tr);

      // Detail row
      var net = calcNetPrice(line.hbelibsr, line.pctdisc1, line.pctdisc2, line.pctdisc3, line.pctppn);
      var nettoBsr = net.final + (line.bkirim || 0);
      var nettoPcs = line.packing > 0 ? nettoBsr / line.packing : 0;
      var mainJual = { hjual1: line.hjual, hjual2: line.hjual2, hjual3: line.hjual3, hjual4: line.hjual4, hjual5: line.hjual5, _enabled: true };

      var detailTr = document.createElement('tr');
      detailTr.className = 'item-detail';
      detailTr.dataset.idx = idx;
      detailTr.innerHTML =
        '<td colspan="4"><div class="dp-grid">' +
          // QTY & Total Harga Beli section
          '<div class="dp-section dp-qty">' +
            '<div class="dp-section-header">Qty & Total Harga Beli</div>' +
            '<div class="dp-input-row">' +
              '<div class="dp-input-group">' +
                '<label class="dp-input-label">Sat. Besar' + (aft.qty != null ? ' <span class="sblm-hint" style="display:inline">' + (aft.qty_besar || aft.qty || 0) + ' ' + esc(stk.satbesar || sat) + '</span>' : '') + '</label>' +
                '<div class="d-flex gap-1 align-items-center">' +
                  '<div class="qty-stepper">' +
                    '<button type="button" class="qty-stepper-btn ed-qtybsr-down" data-idx="' + idx + '"><i class="bi bi-dash"></i></button>' +
                    '<input type="number" class="form-control edit-qty-besar' + (aft.qty != null ? changedCls(aft.qty_besar || aft.qty, line.qty) : '') + '" data-idx="' + idx + '" value="' + line.qty + '" min="0" step="1">' +
                    '<button type="button" class="qty-stepper-btn ed-qtybsr-up" data-idx="' + idx + '"><i class="bi bi-plus"></i></button>' +
                  '</div>' +
                  '<select class="form-select edit-satuan-bsr w-fixed-72" data-idx="' + idx + '">' + unitOpts + '</select>' +
                '</div>' +
              '</div>' +
              '<div class="dp-input-group">' +
                '<label class="dp-input-label">Qty Kcl' + (stk.packing != null ? ' <span class="sblm-hint" style="display:inline">' + (stk.packing || 0) + ' Pcs</span>' : '') + '</label>' +
                '<div class="d-flex gap-1 align-items-center">' +
                  '<div class="qty-stepper">' +
                    '<button type="button" class="qty-stepper-btn ed-packing-down" data-idx="' + idx + '"><i class="bi bi-dash"></i></button>' +
                    '<input type="number" class="form-control edit-packing' + (stk.packing != null ? changedCls(stk.packing, line.packing) : '') + '" data-idx="' + idx + '" value="' + line.packing + '" min="1" step="1">' +
                    '<button type="button" class="qty-stepper-btn ed-packing-up" data-idx="' + idx + '"><i class="bi bi-plus"></i></button>' +
                  '</div>' +
                  '<span class="dp-unit-label">Pcs</span>' +
                '</div>' +
              '</div>' +
              '<div class="dp-input-group">' +
                '<label class="dp-input-label">Total Harga Beli' + (stk.hbelibsr != null ? ' <span class="sblm-hint" style="display:inline">' + fmtNum((stk.hbelibsr || 0) * (line.qty || 1)) + '</span>' : '') + '</label>' +
                '<div class="d-flex align-items-center" style="height:100%">' +
                  '<input type="text" class="form-control edit-price-total text-end' + (stk.hbelibsr != null ? changedCls((stk.hbelibsr || 0) * (line.qty || 1), line.hbelibsr * line.qty) : '') + '" data-idx="' + idx + '" value="' + (line.hbelibsr * line.qty ? fmtNum(line.hbelibsr * line.qty) : '') + '" inputmode="decimal">' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          // Harga Beli section
          '<div class="dp-section dp-beli">' +
            '<div class="dp-section-header">Harga Beli</div>' +
            '<div class="dp-beli-row">' +
              '<span class="dp-label">Beli</span>' +
              '<span class="dp-val hbeli-bsr' + changedCls(stk.hbelibsr, line.hbelibsr) + '" data-idx="' + idx + '">' + (line.hbelibsr ? fmtNum(line.hbelibsr) : '—') + '</span><span class="dp-unit dp-unit-bsr">/' + esc(sat) + '</span>' +
              '<span class="dp-val hbeli-pcs' + changedCls(stk.hbelibsr, line.hbelibsr) + '" data-idx="' + idx + '">' + (line.packing > 0 ? fmtNum(trunc2(line.hbelibsr / line.packing)) : '—') + '</span><span class="dp-unit">/Pcs</span>' +
              (stk.hbelibsr != null ? '<span class="sblm-right">' + fmtNum(stk.hbelibsr) + ' /' + esc(stk.satbesar || sat) + '&ensp;' + (stk.packing ? fmtNum(trunc2((stk.hbelibsr || 0) / (stk.packing || 1))) + ' /Pcs' : '') + '</span>' : '') +
            '</div>' +
            '<table class="beli-table"><thead><tr>' +
              '<th></th>' +
              '<th class="dp-th-total"><span class="dp-unit-bsr">/' + esc(sat) + '</span> &times; <span class="dp-qty-bsr">' + (line.qty || 1) + '</span> =</th>' +
              '<th class="dp-unit-bsr">/' + esc(sat) + '</th>' +
              '<th>/Pcs</th>' +
              '<th>%</th>' +
            '</tr></thead><tbody>' +
              _discRow(idx, 'Diskon 1', 'pctdisc1', line, stk) +
              _discRow(idx, 'Diskon 2', 'pctdisc2', line, stk) +
              _discRow(idx, 'PPN', 'pctppn', line, stk) +
              _discRow(idx, 'Diskon 3', 'pctdisc3', line, stk) +
            '</tbody></table>' +
            '<div class="beli-row-foc"><span class="bt-label">F.O.C</span>' +
              '<input type="number" class="amt-input edit-foc' + (aft.foc != null ? changedCls(aft.foc, line.qtybonus) : '') + '" data-idx="' + idx + '" value="' + (line.qtybonus || '') + '" placeholder="0" min="0" step="1">' +
              '<span class="bt-unit">Pcs</span>' +
              (aft.foc != null ? '<span class="sblm-right">' + (aft.foc ? aft.foc + ' Pcs' : '—') + '</span>' : '') +
            '</div>' +
            '<div class="beli-row-shipping"><span class="bt-label">B.Kirim</span>' +
              '<input type="text" class="amt-input edit-bkirim' + (aft.shipping_cost != null ? changedCls(aft.shipping_cost, line.bkirim) : '') + '" data-idx="' + idx + '" value="' + (line.bkirim ? fmtNum(line.bkirim) : '') + '" placeholder="0" inputmode="decimal">' +
              (aft.shipping_cost != null ? '<span class="sblm-right">' + (aft.shipping_cost ? fmtNum(aft.shipping_cost) : '—') + '</span>' : '') +
            '</div>' +
            (function () {
              var nettoCls = '';
              if (stk.hbelibsr != null) {
                var _sn = calcNetPrice(stk.hbelibsr || 0, stk.pctdisc1 || 0, stk.pctdisc2 || 0, stk.pctdisc3 || 0, stk.pctppn || 0);
                nettoCls = changedCls(_sn.final, nettoBsr);
              }
              return '<div class="dp-netto-row">' +
              '<span class="dp-label">Netto</span>' +
              '<span class="dp-netto-val netto-bsr' + nettoCls + '" data-idx="' + idx + '">' + fmtNum(nettoBsr) + '</span><span class="dp-unit dp-unit-bsr">/' + esc(sat) + '</span>' +
              '<span class="dp-netto-val netto-pcs' + nettoCls + '" data-idx="' + idx + '">' + fmtNum(nettoPcs) + '</span><span class="dp-unit">/Pcs</span>';
            })() +
              (function () {
                if (stk.hbelibsr == null) return '';
                var stkNet = calcNetPrice(stk.hbelibsr || 0, stk.pctdisc1 || 0, stk.pctdisc2 || 0, stk.pctdisc3 || 0, stk.pctppn || 0);
                var stkNettoBsr = stkNet.final;
                var stkPk = stk.packing || 1;
                var stkNettoPcs = stkPk > 0 ? stkNettoBsr / stkPk : 0;
                return '<span class="sblm-right">' + fmtNum(stkNettoBsr) + ' /' + esc(stk.satbesar || sat) + '&ensp;' + fmtNum(stkNettoPcs) + ' /Pcs</span>';
              })() +
            '</div>' +
          '</div>' +
          // Harga Jual section
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

  function _discRow(idx, label, field, line, stk) {
    var net = calcNetPrice(line.hbelibsr, line.pctdisc1, line.pctdisc2, line.pctdisc3, line.pctppn);
    var amtMap = { pctdisc1: net.d1, pctdisc2: net.d2, pctdisc3: net.d3, pctppn: net.ppnAmt };
    var amt = amtMap[field] || 0;
    var qtyBsr = line.qty || 1;
    var cls = changedCls(stk[field], line[field]);
    var hint = sblmPctHint(stk[field]);
    // Calculate snapshot disc amounts for sblm hints
    var stkAmtHint = '', stkTotalHint = '', amtCls = '', totalCls = '';
    if (stk.hbelibsr != null) {
      var stkNet = calcNetPrice(stk.hbelibsr || 0, stk.pctdisc1 || 0, stk.pctdisc2 || 0, stk.pctdisc3 || 0, stk.pctppn || 0);
      var stkAmtMap = { pctdisc1: stkNet.d1, pctdisc2: stkNet.d2, pctdisc3: stkNet.d3, pctppn: stkNet.ppnAmt };
      var stkAmt = stkAmtMap[field] || 0;
      stkAmtHint = '<div class="sblm-hint">' + (stkAmt ? fmtNum(stkAmt) : '—') + '</div>';
      stkTotalHint = '<div class="sblm-hint">' + (stkAmt ? fmtNum(stkAmt * qtyBsr) : '—') + '</div>';
      amtCls = changedCls(stkAmt, amt);
      totalCls = changedCls(stkAmt * qtyBsr, amt * qtyBsr);
    }
    var pack = line.packing || 1;
    var amtPcs = pack > 0 ? amt / pack : 0;
    var stkAmtPcsHint = '', pcsCls = '';
    if (stk.hbelibsr != null) {
      var stkPk = stk.packing || 1;
      var stkAmtPcs = stkPk > 0 ? (stkAmtMap[field] || 0) / stkPk : 0;
      stkAmtPcsHint = '<div class="sblm-hint">' + (stkAmtPcs ? fmtNum(stkAmtPcs) : '—') + '</div>';
      pcsCls = fmtNum(stkAmtPcs) !== fmtNum(amtPcs) ? ' value-changed' : '';
    }
    return '<tr>' +
      '<td class="bt-label">' + label + '</td>' +
      '<td>' + stkTotalHint + '<input type="text" class="amt-total edit-disc-total' + totalCls + '" data-idx="' + idx + '" data-field="' + field + '" value="' + (amt ? fmtNum(amt * qtyBsr) : '') + '" placeholder="0" inputmode="decimal"></td>' +
      '<td>' + stkAmtHint + '<input type="text" class="amt-input edit-disc-amt' + amtCls + '" data-idx="' + idx + '" data-field="' + field + '" value="' + (amt ? fmtNum(amt) : '') + '" placeholder="0" inputmode="decimal"></td>' +
      '<td class="disc-pcs" data-idx="' + idx + '" data-field="' + field + '">' + stkAmtPcsHint + '<input type="text" class="amt-input' + pcsCls + '" value="' + (amtPcs ? fmtNum(amtPcs) : '0') + '" readonly tabindex="-1"></td>' +
      '<td>' + hint + '<input type="number" class="pct-input edit-disc-pct' + cls + '" data-idx="' + idx + '" data-field="' + field + '" value="' + (line[field] || '') + '" placeholder="—" step="any" min="0" max="100"></td>' +
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

    // Stock snapshot for comparison
    var stk = beforePrices[line.stockid] || {};
    var hasStk = stk.hbelibsr != null;

    // Netto
    var nBsr = document.querySelector('.netto-bsr[data-idx="' + idx + '"]');
    var nPcs = document.querySelector('.netto-pcs[data-idx="' + idx + '"]');
    if (nBsr) nBsr.textContent = h ? fmtNum(finalBsr) : '—';
    if (nPcs) nPcs.textContent = (h && pk > 0) ? fmtNum(finalBsr / pk) : '—';
    if (hasStk) {
      var stkNetC = calcNetPrice(stk.hbelibsr || 0, stk.pctdisc1 || 0, stk.pctdisc2 || 0, stk.pctdisc3 || 0, stk.pctppn || 0);
      var nChanged = fmtNum(stkNetC.final) !== fmtNum(finalBsr);
      if (nBsr) nBsr.classList.toggle('value-changed', nChanged);
      if (nPcs) nPcs.classList.toggle('value-changed', nChanged);
    }

    // Total Harga Beli highlight
    var totalEl = document.querySelector('.edit-price-total[data-idx="' + idx + '"]');
    if (totalEl && hasStk) {
      var stkTotal = (stk.hbelibsr || 0) * (line.qty || 1);
      var curTotal = h * (line.qty || 1);
      totalEl.classList.toggle('value-changed', fmtNum(stkTotal) !== fmtNum(curTotal));
    }

    // Beli
    var bBsr = document.querySelector('.hbeli-bsr[data-idx="' + idx + '"]');
    var bPcs = document.querySelector('.hbeli-pcs[data-idx="' + idx + '"]');
    if (bBsr) bBsr.textContent = h ? fmtNum(h) : '—';
    if (bPcs) bPcs.textContent = (h && pk > 0) ? fmtNum(trunc2(h / pk)) : '—';
    if (hasStk) {
      var bChanged = fmtNum(stk.hbelibsr || 0) !== fmtNum(h);
      if (bBsr) bBsr.classList.toggle('value-changed', bChanged);
      if (bPcs) bPcs.classList.toggle('value-changed', bChanged);
    }

    // Disc amounts
    var qtyBsr = line.qty || 1;
    var amtMap = { pctdisc1: net.d1, pctdisc2: net.d2, pctdisc3: net.d3, pctppn: net.ppnAmt };
    var stkAmtMap2 = {};
    if (hasStk) {
      var _sn2 = calcNetPrice(stk.hbelibsr || 0, stk.pctdisc1 || 0, stk.pctdisc2 || 0, stk.pctdisc3 || 0, stk.pctppn || 0);
      stkAmtMap2 = { pctdisc1: _sn2.d1, pctdisc2: _sn2.d2, pctdisc3: _sn2.d3, pctppn: _sn2.ppnAmt };
    }
    ['pctdisc1','pctdisc2','pctdisc3','pctppn'].forEach(function (f) {
      var amtEl = document.querySelector('.edit-disc-amt[data-idx="' + idx + '"][data-field="' + f + '"]');
      if (amtEl && document.activeElement !== amtEl) amtEl.value = amtMap[f] ? fmtNum(amtMap[f]) : '';
      var totEl = document.querySelector('.edit-disc-total[data-idx="' + idx + '"][data-field="' + f + '"]');
      if (totEl && document.activeElement !== totEl) totEl.value = amtMap[f] ? fmtNum(amtMap[f] * qtyBsr) : '';
      var pcsEl = document.querySelector('.disc-pcs[data-idx="' + idx + '"][data-field="' + f + '"]');
      var amtPcs = (pk > 0 && amtMap[f]) ? amtMap[f] / pk : 0;
      if (pcsEl) {
        var pcsInput = pcsEl.querySelector('input');
        if (pcsInput) pcsInput.value = amtPcs ? fmtNum(amtPcs) : '0';
      }
      var pctEl = document.querySelector('.edit-disc-pct[data-idx="' + idx + '"][data-field="' + f + '"]');
      if (hasStk) {
        var stkAmt = stkAmtMap2[f] || 0;
        var curAmt = amtMap[f] || 0;
        // Compare against displayed input value to handle active editing
        var dispAmt = amtEl ? fmtNum(parseNum(amtEl.value)) : fmtNum(curAmt);
        var dispTotal = totEl ? fmtNum(parseNum(totEl.value)) : fmtNum(curAmt * qtyBsr);
        var amtDiff = fmtNum(stkAmt) !== dispAmt;
        var totalDiff = fmtNum(stkAmt * qtyBsr) !== dispTotal;
        var pctDiff = Math.abs(Math.round((stk[f] || 0) * 100) - Math.round((line[f] || 0) * 100)) >= 1;
        if (amtEl) amtEl.classList.toggle('value-changed', amtDiff);
        if (totEl) totEl.classList.toggle('value-changed', totalDiff);
        if (pctEl) pctEl.classList.toggle('value-changed', pctDiff);
        // Highlight /Pcs cell
        if (pcsEl) {
          var stkPcsAmt = (stk.packing || 1) > 0 ? stkAmt / (stk.packing || 1) : 0;
          var pcsInput2 = pcsEl.querySelector('input');
          if (pcsInput2) pcsInput2.classList.toggle('value-changed', fmtNum(stkPcsAmt) !== fmtNum(amtPcs));
        }
      }
    });

    // Stock netto/pcs for margin comparison
    var stkNettoPcsC = 0;
    if (hasStk) {
      var _snc = calcNetPrice(stk.hbelibsr || 0, stk.pctdisc1 || 0, stk.pctdisc2 || 0, stk.pctdisc3 || 0, stk.pctppn || 0);
      var _spk = stk.packing || 1;
      stkNettoPcsC = _spk > 0 ? _snc.final / _spk : 0;
    }
    var _bundlingStkMap = {
      1: { hjual1: 'hjualo1', hjual2: 'hjual2o1', hjual3: 'hjual3o1', hjual4: 'hjual4o1', hjual5: 'hjual5o1' },
      2: { hjual1: 'hjualo2', hjual2: 'hjual2o2', hjual3: 'hjual3o2', hjual4: 'hjual4o2', hjual5: 'hjual5o2' },
    };

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
        var jualEl = document.querySelector('.jual-input[data-idx="' + idx + '"][data-tier="' + tier + '"][data-field="' + f + '"]');
        var pctEl = document.querySelector('.jual-pct-input[data-idx="' + idx + '"][data-tier="' + tier + '"][data-field="' + f + '"]');
        var mrgEl = document.querySelector('.jual-margin[data-idx="' + idx + '"][data-tier="' + tier + '"][data-field="' + f + '"]');
        if (!pctEl || !mrgEl) return;

        // Update jual input highlight
        if (hasStk && jualEl) {
          var stkFld = tier === 'main' ? (f === 'hjual1' ? 'hjual' : f) : (_bundlingStkMap[tier] ? _bundlingStkMap[tier][f] : null);
          var sv2 = stkFld ? (Number(stk[stkFld]) || 0) : 0;
          var jChanged = fmtNum(sv2) !== fmtNum(Number(val) || 0);
          jualEl.classList.toggle('value-changed', jChanged);
        }

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

        // Highlight margin/pct if different from stock
        if (hasStk && stkNettoPcsC) {
          var stkField = tier === 'main' ? (f === 'hjual1' ? 'hjual' : f) : (_bundlingStkMap[tier] ? _bundlingStkMap[tier][f] : null);
          var stkVal = stkField ? (Number(stk[stkField]) || 0) : 0;
          if (stkVal) {
            var stkMargin = stkVal - stkNettoPcsC;
            var stkPct = (stkMargin / stkNettoPcsC) * 100;
            var mrgChanged = fmtNum(stkMargin) !== fmtNum(margin);
            var pctChanged = stkPct.toFixed(2) !== pct.toFixed(2);
            mrgEl.classList.toggle('value-changed', mrgChanged);
            pctEl.classList.toggle('value-changed', pctChanged);
          } else {
            mrgEl.classList.toggle('value-changed', true);
            pctEl.classList.toggle('value-changed', true);
          }
        }
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
        var inp = table.querySelector('.edit-qty-besar[data-idx="' + idx + '"]');
        if (inp) inp.value = editLines[idx].qty;
        recalcLine(idx);
      });
    });
    table.querySelectorAll('.ed-qtybsr-down').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.dataset.idx);
        if (editLines[idx].qty <= 0) return;
        editLines[idx].qty -= 1;
        var inp = table.querySelector('.edit-qty-besar[data-idx="' + idx + '"]');
        if (inp) inp.value = editLines[idx].qty;
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
        var inp = table.querySelector('.edit-packing[data-idx="' + idx + '"]');
        if (inp) inp.value = editLines[idx].packing;
        recalcLine(idx);
      });
    });
    table.querySelectorAll('.ed-packing-down').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.dataset.idx);
        if (editLines[idx].packing <= 1) return;
        editLines[idx].packing -= 1;
        var inp = table.querySelector('.edit-packing[data-idx="' + idx + '"]');
        if (inp) inp.value = editLines[idx].packing;
        recalcLine(idx);
      });
    });

    // Satuan
    table.querySelectorAll('.edit-satuan-bsr').forEach(function (el) {
      el.addEventListener('change', function () {
        var idx = parseInt(el.dataset.idx);
        editLines[idx].satuanbsr = el.value;
        var detail = table.querySelector('.item-detail[data-idx="' + idx + '"]');
        if (detail) {
          detail.querySelectorAll('.dp-unit-bsr').forEach(function (s) { s.textContent = '/' + el.value; });
        }
        updateComputedPrices(idx);
      });
    });

    // Total Harga Beli
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

    // Disc amount -> convert to %
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

    // Disc total -> convert to per-unit then %
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
        var idx = parseInt(el.dataset.idx);
        editLines[idx].qtybonus = parseInt(el.value) || 0;
        var aft = afterPrices[editLines[idx].stockid] || {};
        if (aft.foc != null) {
          el.classList.toggle('value-changed', fmtNum(aft.foc) !== fmtNum(editLines[idx].qtybonus));
        }
      });
    });

    // B.Kirim
    table.querySelectorAll('.edit-bkirim').forEach(function (el) {
      el.addEventListener('change', function () {
        var idx = parseInt(el.dataset.idx);
        editLines[idx].bkirim = parseNum(el.value);
        el.value = editLines[idx].bkirim ? fmtNum(editLines[idx].bkirim) : '';
        var aft = afterPrices[editLines[idx].stockid] || {};
        if (aft.shipping_cost != null) {
          el.classList.toggle('value-changed', fmtNum(aft.shipping_cost) !== fmtNum(editLines[idx].bkirim));
        }
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

    // Jual MRG% input -> calc hjual from margin percentage
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
        var mqEl = table.querySelector('.bundling-minqty[data-idx="' + idx + '"][data-tier="' + tier + '"]');
        if (mqEl) mqEl.disabled = !el.checked;
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
    var detail = document.querySelector('#editItemTable .item-detail[data-idx="' + idx + '"]');
    if (detail) {
      detail.querySelectorAll('.dp-qty-bsr').forEach(function (s) { s.textContent = line.qty || 1; });
    }
    // Update total price display
    var totalEl = document.querySelector('.edit-price-total[data-idx="' + idx + '"]');
    if (totalEl && document.activeElement !== totalEl) {
      var total = line.hbelibsr * (line.qty || 1);
      totalEl.value = total ? fmtNum(total) : '';
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

    // Validate bundling: if enabled, minQty must be > 0
    for (var i = 0; i < editLines.length; i++) {
      var ln = editLines[i];
      for (var t = 1; t <= 2; t++) {
        var bk = ln['bundling' + t];
        if (bk && bk.enabled && !bk.minQty) {
          if (window.showToast) window.showToast((ln.artname || ln.stockid) + ': Bundling ' + t + ' aktif tapi Qty belum diisi.', 'warning');
          return;
        }
      }
    }

    var ok = window.showConfirm
      ? await window.showConfirm('Update faktur ' + currentFP.nofaktur + ' dan update stok?')
      : confirm('Update faktur ' + currentFP.nofaktur + ' dan update stok?');
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
          fp_number: currentFP.nofaktur,
          supplier_id: elSupplier.value,
          userid: elUser.value,
          items: items,
          order_date: elDate.value,
          update_price: elUpdatePrice ? elUpdatePrice.checked : true,
        }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);

      if (window.showToast) window.showToast('Faktur ' + currentFP.nofaktur + ' berhasil diupdate (' + data.line_count + ' item)', 'success');
      closeEdit();
      window.location.reload();
    } catch (err) {
      if (window.showToast) window.showToast('Update gagal: ' + err.message, 'danger');
    } finally {
      elBtnSave.disabled = false;
      elBtnSave.innerHTML = '<i class="bi bi-check-lg"></i> Simpan';
    }
  });

  // ------- Expand / Collapse all -------
  var table = document.getElementById('editItemTable');
  document.getElementById('editExpandAll').addEventListener('click', function() {
    table.querySelectorAll('.item-detail').forEach(function(d) { d.classList.add('open'); });
    table.querySelectorAll('.item-main').forEach(function(m) { m.classList.add('has-detail-open'); });
  });
  document.getElementById('editCollapseAll').addEventListener('click', function() {
    table.querySelectorAll('.item-detail').forEach(function(d) { d.classList.remove('open'); });
    table.querySelectorAll('.item-main').forEach(function(m) { m.classList.remove('has-detail-open'); });
  });

  // ------- Back / Escape -------
  elBtnBack.addEventListener('click', closeEdit);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !overlay.classList.contains('d-none')) {
      if (document.querySelector('.modal.show')) return;
      closeEdit();
    }
  });

  // ------- Wire up edit buttons (event delegation for dynamic rows) -------
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.btn-edit-fp');
    if (btn && !btn.disabled) {
      openEdit(btn.dataset.fp);
    }
  });
})();
