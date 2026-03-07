/**
 * FOC (Barang Diskon) History Page
 */
(function () {
  'use strict';

  var elFrom      = document.getElementById('focDateFrom');
  var elTo        = document.getElementById('focDateTo');
  var elBtnSearch = document.getElementById('focBtnSearch');
  var elSummary   = document.getElementById('focSummary');
  var elLoading   = document.getElementById('focLoading');
  var elResults   = document.getElementById('focResults');
  var elEmpty     = document.getElementById('focEmpty');
  var elBody      = document.getElementById('focTableBody');
  var elCount     = document.getElementById('focResultCount');
  var elBtnExport = document.getElementById('focBtnExport');
  var elBtnExportPdf = document.getElementById('focBtnExportPdf');
  var elTotalItems = document.getElementById('focTotalItems');
  var elTotalQty   = document.getElementById('focTotalQty');

  if (!elFrom) return;

  var rows = [];
  var sortCol = 'tanggal';
  var sortAsc = false;

  // Helpers
  function fmtInt(n) {
    if (n == null || isNaN(n)) return '0';
    return Number(n).toLocaleString('en-US');
  }

  function pad(d) { return String(d).padStart(2, '0'); }

  function toDateStr(dt) {
    return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
  }

  function esc(str) {
    if (!str) return '';
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // Presets
  var presets = document.querySelectorAll('.sh-preset');

  function applyPreset(name) {
    var today = new Date();
    var from, to;
    var sod = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    switch (name) {
      case 'today':
        from = toDateStr(sod); to = toDateStr(sod);
        break;
      case 'yesterday':
        var ys = new Date(sod); ys.setDate(ys.getDate() - 1);
        from = toDateStr(ys); to = toDateStr(ys);
        break;
      case '7d':
        var d7 = new Date(sod); d7.setDate(d7.getDate() - 6);
        from = toDateStr(d7); to = toDateStr(sod);
        break;
      case '30d':
        var d30 = new Date(sod); d30.setDate(d30.getDate() - 29);
        from = toDateStr(d30); to = toDateStr(sod);
        break;
      case 'month':
        from = toDateStr(new Date(today.getFullYear(), today.getMonth(), 1));
        to = toDateStr(sod);
        break;
      case 'year':
        from = toDateStr(new Date(today.getFullYear(), 0, 1));
        to = toDateStr(sod);
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

  // Fetch
  function fetchData() {
    var from = elFrom.value;
    var to = elTo.value;
    if (!from || !to) return;

    elLoading.classList.remove('d-none');
    elResults.classList.add('d-none');
    elEmpty.classList.add('d-none');
    elSummary.classList.add('d-none');

    var url = '/api/foc/history?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
    fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        elLoading.classList.add('d-none');
        rows = data;

        if (!rows.length) {
          elEmpty.classList.remove('d-none');
          return;
        }

        var totalQty = 0;
        rows.forEach(function (r) {
          totalQty += Number(r.qtybonus) || 0;
        });
        elTotalItems.textContent = fmtInt(rows.length);
        elTotalQty.textContent = fmtInt(totalQty);
        elSummary.classList.remove('d-none');

        elCount.textContent = rows.length + ' record';
        sortCol = 'tanggal';
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

  // Render
  function _sorted() {
    return rows.slice().sort(function (a, b) {
      var va = a[sortCol], vb = b[sortCol];
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return 0;
    });
  }

  function renderTable() {
    var sorted = _sorted();

    elBody.innerHTML = sorted.map(function (r, i) {
      var suppText = r.suppid || '';
      if (r.suppname) suppText += ' - ' + r.suppname;
      return '<tr>' +
        '<td class="text-center">' + (i + 1) + '</td>' +
        '<td>' + esc(r.tanggal || '') + '</td>' +
        '<td>' + esc(r.stockid || '') + '</td>' +
        '<td>' + esc(r.artname || '') + '</td>' +
        '<td class="text-end fw-semibold">' + fmtInt(r.qtybonus) + '</td>' +
        '<td style="white-space:nowrap">' + esc((r.packing || '') + ' ' + (r.satuankcl || 'Pcs') + '/' + (r.satuanbsr || '')) + '</td>' +
        '<td>' + esc(suppText) + '</td>' +
        '<td><code>' + esc(r.nofaktur || '') + '</code></td>' +
        '</tr>';
    }).join('');

    document.querySelectorAll('#focResults .sh-sortable').forEach(function (th) {
      var icon = th.querySelector('i');
      if (th.dataset.col === sortCol) {
        icon.className = sortAsc ? 'bi bi-chevron-up' : 'bi bi-chevron-down';
      } else {
        icon.className = 'bi bi-chevron-expand';
      }
    });
  }

  // Sort
  document.querySelectorAll('#focResults .sh-sortable').forEach(function (th) {
    th.addEventListener('click', function () {
      var col = th.dataset.col;
      if (sortCol === col) {
        sortAsc = !sortAsc;
      } else {
        sortCol = col;
        sortAsc = (col === 'artname' || col === 'stockid');
      }
      renderTable();
    });
  });

  // CSV Export (client-side)
  elBtnExport.addEventListener('click', function () {
    if (!rows.length) return;

    var sorted = _sorted();
    var csvRows = [['#', 'Tanggal', 'Artno', 'Nama Barang', 'FOC (Pcs)', 'Satuan', 'Supplier', 'No Faktur']];
    sorted.forEach(function (r, i) {
      csvRows.push([
        i + 1,
        r.tanggal || '',
        r.stockid || '',
        r.artname || '',
        r.qtybonus || 0,
        (r.packing || '') + ' ' + (r.satuankcl || 'Pcs') + '/' + (r.satuanbsr || ''),
        (r.suppid || '') + (r.suppname ? ' - ' + r.suppname : ''),
        r.nofaktur || ''
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
    link.href = URL.createObjectURL(blob);
    link.download = 'barang_diskon_' + elFrom.value + '_' + elTo.value + '.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  });

  // PDF Export
  elBtnExportPdf.addEventListener('click', function () {
    if (!rows.length) return;

    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    doc.setFontSize(14);
    doc.text('Barang Bonus (FOC)', 14, 15);
    doc.setFontSize(9);
    doc.text('Periode: ' + elFrom.value + '  s/d  ' + elTo.value, 14, 21);

    var sorted = _sorted();
    var totalFoc = 0;
    var tableRows = sorted.map(function (r, i) {
      totalFoc += Number(r.qtybonus) || 0;
      return [
        i + 1,
        r.tanggal || '',
        r.stockid || '',
        r.artname || '',
        fmtInt(r.qtybonus),
        (r.packing || '') + ' ' + (r.satuankcl || 'Pcs') + '/' + (r.satuanbsr || ''),
        (r.suppid || '') + (r.suppname ? ' - ' + r.suppname : ''),
        r.nofaktur || ''
      ];
    });
    tableRows.push(['', '', '', '', fmtInt(totalFoc), '', 'TOTAL', '']);

    doc.autoTable({
      startY: 25,
      head: [['#', 'Tanggal', 'Artno', 'Nama Barang', 'FOC', 'Satuan', 'Supplier', 'No Faktur']],
      body: tableRows,
      styles: { fontSize: 8, cellPadding: 1.5 },
      headStyles: { fillColor: [40, 167, 69] },
      columnStyles: {
        0: { halign: 'center', cellWidth: 10 },
        4: { halign: 'right' },
      },
      didParseCell: function (data) {
        if (data.row.index === tableRows.length - 1) {
          data.cell.styles.fontStyle = 'bold';
        }
      },
    });

    doc.save('barang_diskon_' + elFrom.value + '_' + elTo.value + '.pdf');
  });

  // Init
  applyPreset('30d');

})();
