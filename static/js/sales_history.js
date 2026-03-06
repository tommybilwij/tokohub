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
  var elBtnExportPdf = document.getElementById('shBtnExportPdf');
  var elDeptDropdown = document.getElementById('shDeptDropdown');
  var elDeptBtn = document.getElementById('shDeptBtn');
  var elDeptMenu = document.getElementById('shDeptMenu');
  var elDeptList = document.getElementById('shDeptList');
  var elDeptAll = document.querySelector('.sh-dept-all');
  var elTotalItems = document.getElementById('shTotalItems');
  var elTotalQty   = document.getElementById('shTotalQty');
  var elTotalSales = document.getElementById('shTotalSales');

  // Guard: only run on sales history page
  if (!elFrom) return;

  var rows = [];
  var sortCol = 'total_amount';
  var sortAsc = false;

  // Load departments
  fetch('/api/sales/departments')
    .then(function (res) { return res.json(); })
    .then(function (depts) {
      depts.forEach(function (d) {
        var label = document.createElement('label');
        label.className = 'sh-dept-item';
        label.innerHTML = '<input type="checkbox" value="' + esc(d.id) + '" class="sh-dept-cb"> ' + esc(d.id) + ' - ' + esc(d.name);
        elDeptList.appendChild(label);
      });
    });

  // Dropdown toggle
  elDeptBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    elDeptMenu.classList.toggle('open');
  });
  document.addEventListener('click', function (e) {
    if (!elDeptDropdown.contains(e.target)) elDeptMenu.classList.remove('open');
  });

  // "Semua" checkbox
  elDeptAll.addEventListener('change', function () {
    var cbs = elDeptList.querySelectorAll('.sh-dept-cb');
    if (elDeptAll.checked) {
      cbs.forEach(function (cb) { cb.checked = false; });
    }
    _updateDeptLabel();
  });

  // Individual dept checkboxes
  elDeptMenu.addEventListener('change', function (e) {
    if (e.target.classList.contains('sh-dept-cb')) {
      elDeptAll.checked = false;
      var any = elDeptList.querySelector('.sh-dept-cb:checked');
      if (!any) elDeptAll.checked = true;
      _updateDeptLabel();
    }
  });

  function _getSelectedDepts() {
    if (elDeptAll.checked) return '';
    var selected = [];
    elDeptList.querySelectorAll('.sh-dept-cb:checked').forEach(function (cb) {
      selected.push(cb.value);
    });
    return selected.join(',');
  }

  function _updateDeptLabel() {
    var sel = _getSelectedDepts();
    elDeptBtn.textContent = sel ? sel.split(',').length + ' dept' : 'Semua';
  }

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

  // No auto-fetch on dept change — user clicks Cari

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

    var dept = _getSelectedDepts();
    var url = '/api/sales/history?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
    if (dept) url += '&dept=' + encodeURIComponent(dept);
    fetch(url)
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
        '<td>' + esc(r.artno || '') + '</td>' +
        '<td><code>' + esc(r.barcode || '') + '</code></td>' +
        '<td class="text-center">' + esc(r.deptid || '') + '</td>' +
        '<td>' + esc(r.artname) + '</td>' +
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
    if (!rows.length) return;

    var sorted = rows.slice().sort(function (a, b) {
      var va = a[sortCol], vb = b[sortCol];
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return 0;
    });

    var csvRows = [['#', 'Artno', 'Barcode', 'Dept', 'Nama Barang', 'Harga Jual', 'Qty', 'Total']];
    sorted.forEach(function (r, i) {
      var barcode = r.barcode || '';
      csvRows.push([
        i + 1,
        r.artno || '',
        barcode ? "'" + barcode : '',
        r.deptid || '',
        r.artname || '',
        r.hjual || 0,
        r.total_qty || 0,
        r.total_amount || 0
      ]);
    });

    var csv = csvRows.map(function (row) {
      return row.map(function (cell) {
        var s = String(cell);
        if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      }).join(',');
    }).join('\n');

    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    var f = elFrom.value.replace('T', '_').replace(/:/g, '');
    var t = elTo.value.replace('T', '_').replace(/:/g, '');
    link.href = URL.createObjectURL(blob);
    link.download = 'penjualan_' + f + '_' + t + '.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  });

  // -----------------------------------------------------------------------
  // Export PDF
  // -----------------------------------------------------------------------
  elBtnExportPdf.addEventListener('click', function () {
    if (!rows.length) return;

    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    var from = elFrom.value.replace('T', ' ');
    var to = elTo.value.replace('T', ' ');
    var deptSel = _getSelectedDepts();
    var deptText = deptSel ? ('Dept ' + deptSel) : 'Semua Dept';
    doc.setFontSize(14);
    doc.text('Histori Penjualan', 14, 15);
    doc.setFontSize(9);
    doc.text('Periode: ' + from + '  s/d  ' + to + '   |   ' + deptText, 14, 21);

    var sorted = rows.slice().sort(function (a, b) {
      var va = a[sortCol], vb = b[sortCol];
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return 0;
    });

    var totalQty = 0, totalAmount = 0;
    var tableRows = sorted.map(function (r, i) {
      totalQty += Number(r.total_qty) || 0;
      totalAmount += Number(r.total_amount) || 0;
      return [i + 1, r.artno || '', r.barcode || '', r.deptid || '', r.artname || '', fmt(r.hjual), fmtInt(r.total_qty), fmt(r.total_amount)];
    });
    tableRows.push(['', '', '', '', '', 'TOTAL', fmtInt(totalQty), fmt(totalAmount)]);

    doc.autoTable({
      startY: 25,
      head: [['#', 'Artno', 'Barcode', 'Dept', 'Nama Barang', 'Harga Jual', 'Qty', 'Total']],
      body: tableRows,
      styles: { fontSize: 8, cellPadding: 1.5 },
      headStyles: { fillColor: [40, 167, 69] },
      columnStyles: {
        0: { halign: 'center', cellWidth: 10 },
        3: { halign: 'center', cellWidth: 14 },
        5: { halign: 'right' },
        6: { halign: 'right' },
        7: { halign: 'right' },
      },
      didParseCell: function (data) {
        if (data.row.index === tableRows.length - 1) {
          data.cell.styles.fontStyle = 'bold';
        }
      },
    });

    var f = elFrom.value.replace('T', '_').replace(/:/g, '');
    var t = elTo.value.replace('T', '_').replace(/:/g, '');
    doc.save('penjualan_' + f + '_' + t + '.pdf');
  });

  // -----------------------------------------------------------------------
  // Init: load today
  // -----------------------------------------------------------------------
  applyPreset('today');

})();
