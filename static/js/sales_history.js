/**
 * Sales History Page
 */
(function () {
  'use strict';

  var elFrom      = document.getElementById('shDateFrom');
  var elTo        = document.getElementById('shDateTo');
  var elBtnSearch = document.getElementById('shBtnSearch');
  var elSummary   = document.getElementById('shSummary');
  var elLoading   = document.getElementById('shLoading');
  var elResults   = document.getElementById('shResults');
  var elEmpty     = document.getElementById('shEmpty');
  var elBody      = document.getElementById('shTableBody');
  var elCount     = document.getElementById('shResultCount');
  var elBtnExport = document.getElementById('shBtnExport');
  var elTotalItems = document.getElementById('shTotalItems');
  var elTotalQty   = document.getElementById('shTotalQty');
  var elTotalSales = document.getElementById('shTotalSales');

  // Guard: only run on sales history page
  if (!elFrom) return;

  var rows = [];
  var sortCol = 'total_amount';
  var sortAsc = false;

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------
  function fmt(n) {
    if (n == null || isNaN(n)) return '0';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtInt(n) {
    if (n == null || isNaN(n)) return '0';
    return Number(n).toLocaleString('en-US');
  }

  function pad(d) { return String(d).padStart(2, '0'); }

  function toDateStr(dt) {
    return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
  }

  function toDateTimeStr(dt) {
    return toDateStr(dt) + 'T' + pad(dt.getHours()) + ':' + pad(dt.getMinutes());
  }


  function esc(str) {
    if (!str) return '';
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // -----------------------------------------------------------------------
  // Presets
  // -----------------------------------------------------------------------
  var presets = document.querySelectorAll('.sh-preset');

  function applyPreset(name) {
    var today = new Date();
    var from, to;

    var sod = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0);
    var eod = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59);

    switch (name) {
      case 'today':
        from = toDateTimeStr(sod); to = toDateTimeStr(eod);
        break;
      case 'yesterday':
        var ys = new Date(sod); ys.setDate(ys.getDate() - 1);
        var ye = new Date(ys); ye.setHours(23, 59);
        from = toDateTimeStr(ys); to = toDateTimeStr(ye);
        break;
      case '7d':
        var d7 = new Date(sod); d7.setDate(d7.getDate() - 6);
        from = toDateTimeStr(d7); to = toDateTimeStr(eod);
        break;
      case '30d':
        var d30 = new Date(sod); d30.setDate(d30.getDate() - 29);
        from = toDateTimeStr(d30); to = toDateTimeStr(eod);
        break;
      case 'month':
        from = toDateTimeStr(new Date(today.getFullYear(), today.getMonth(), 1, 0, 0));
        to = toDateTimeStr(eod);
        break;
      case 'year':
        from = toDateTimeStr(new Date(today.getFullYear(), 0, 1, 0, 0));
        to = toDateTimeStr(eod);
        break;
      default: return;
    }

    elFrom.value = from;
    elTo.value = to;

    presets.forEach(function (b) { b.classList.toggle('active', b.dataset.preset === name); });
    fetchData();
  }

  presets.forEach(function (btn) {
    btn.addEventListener('click', function () { applyPreset(btn.dataset.preset); });
  });

  elBtnSearch.addEventListener('click', function () {
    presets.forEach(function (b) { b.classList.remove('active'); });
    fetchData();
  });

  // -----------------------------------------------------------------------
  // Fetch data
  // -----------------------------------------------------------------------
  function fetchData() {
    var from = elFrom.value;
    var to = elTo.value;
    if (!from || !to) return;

    elLoading.classList.remove('d-none');
    elResults.classList.add('d-none');
    elEmpty.classList.add('d-none');
    elSummary.classList.add('d-none');

    fetch('/api/sales/history?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        elLoading.classList.add('d-none');
        rows = data;

        if (!rows.length) {
          elEmpty.classList.remove('d-none');
          return;
        }

        // Summary
        var totalQty = 0, totalAmount = 0;
        rows.forEach(function (r) {
          totalQty += Number(r.total_qty) || 0;
          totalAmount += Number(r.total_amount) || 0;
        });
        elTotalItems.textContent = fmtInt(rows.length);
        elTotalQty.textContent = fmtInt(totalQty);
        elTotalSales.textContent = fmt(totalAmount);
        elSummary.classList.remove('d-none');

        elCount.textContent = rows.length + ' barang';
        sortCol = 'total_amount';
        sortAsc = false;
        renderTable();
        elResults.classList.remove('d-none');
      })
      .catch(function (err) {
        elLoading.classList.add('d-none');
        console.error('Fetch failed:', err);
        elEmpty.classList.remove('d-none');
      });
  }

  // -----------------------------------------------------------------------
  // Render table
  // -----------------------------------------------------------------------
  function renderTable() {
    var sorted = rows.slice().sort(function (a, b) {
      var va = a[sortCol], vb = b[sortCol];
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return 0;
    });

    elBody.innerHTML = sorted.map(function (r, i) {
      return '<tr>' +
        '<td class="text-center">' + (i + 1) + '</td>' +
        '<td>' + esc(r.artname) + '</td>' +
        '<td><code>' + esc(r.barcode || '') + '</code></td>' +
        '<td class="text-end">' + fmt(r.hjual) + '</td>' +
        '<td class="text-end">' + fmtInt(r.total_qty) + '</td>' +
        '<td class="text-end fw-semibold">' + fmt(r.total_amount) + '</td>' +
        '</tr>';
    }).join('');

    // Update sort indicators
    document.querySelectorAll('.sh-sortable').forEach(function (th) {
      var icon = th.querySelector('i');
      if (th.dataset.col === sortCol) {
        icon.className = sortAsc ? 'bi bi-chevron-up' : 'bi bi-chevron-down';
      } else {
        icon.className = 'bi bi-chevron-expand';
      }
    });
  }

  // -----------------------------------------------------------------------
  // Column sorting
  // -----------------------------------------------------------------------
  document.querySelectorAll('.sh-sortable').forEach(function (th) {
    th.addEventListener('click', function () {
      var col = th.dataset.col;
      if (sortCol === col) {
        sortAsc = !sortAsc;
      } else {
        sortCol = col;
        sortAsc = (col === 'artname' || col === 'barcode');
      }
      renderTable();
    });
  });

  // -----------------------------------------------------------------------
  // Export CSV
  // -----------------------------------------------------------------------
  elBtnExport.addEventListener('click', function () {
    var from = elFrom.value;
    var to = elTo.value;
    if (!from || !to) return;
    window.location.href = '/api/sales/export?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
  });

  // -----------------------------------------------------------------------
  // Init: load today
  // -----------------------------------------------------------------------
  applyPreset('today');

})();
