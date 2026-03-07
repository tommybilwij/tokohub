/**
 * Perubahan Harga — edit harga jual for stock items.
 * Layout mirrors Input Barang with collapsible detail rows.
 */
(function() {
  const items = [];
  // Each item: {artno, artname, hbelibsr, hbelikcl, hbelinetto, packing, satbesar,
  //   hjual, hjual2, hjual3, hjual4, hjual5,
  //   newHjual, newHjual2, newHjual3, newHjual4, newHjual5}

  const searchInput = document.getElementById('pcSearchInput');
  const searchResults = document.getElementById('pcSearchResults');
  const tableBody = document.getElementById('pcTableBody');
  const itemCount = document.getElementById('pcItemCount');
  const btnCommit = document.getElementById('pcBtnCommit');
  const btnClear = document.getElementById('pcBtnClear');

  function fmt(n) { return new Intl.NumberFormat('id-ID', {maximumFractionDigits:2}).format(n); }
  function fmtNz(n) { return n ? fmt(n) : '—'; }
  function parseNum(s) { return parseFloat(String(s).replace(/\./g, '').replace(',', '.')) || 0; }

  function calcNetPrice(hbelibsr, d1, d2, d3, ppn) {
    let price = hbelibsr;
    const disc1Amt = price * (d1 || 0) / 100; price -= disc1Amt;
    const disc2Amt = price * (d2 || 0) / 100; price -= disc2Amt;
    const ppnAmt = price * (ppn || 0) / 100; price += ppnAmt;
    const disc3Amt = price * (d3 || 0) / 100; price -= disc3Amt;
    return { final: price, disc1Amt, disc2Amt, ppnAmt, disc3Amt };
  }

  function renderJualTable(itemIdx, tier, vals, nettoPcs) {
    const t = tier == null ? 'main' : tier;
    const dis = tier != null && !vals._enabled ? 'disabled' : '';
    const rows = [
      { label: 'Jual 1', field: 'hjual1', newField: 'newHjual1' },
      { label: 'Member', field: 'hjual2', newField: 'newHjual2' },
      { label: 'Jual 3', field: 'hjual3', newField: 'newHjual3' },
      { label: 'Jual 4', field: 'hjual4', newField: 'newHjual4' },
      { label: 'Jual 5', field: 'hjual5', newField: 'newHjual5' },
    ];
    const rowsHTML = rows.map(r => {
      // For main tier, field names are newHjual, newHjual2, etc.
      const newFieldKey = tier == null
        ? (r.field === 'hjual1' ? 'newHjual' : 'new' + r.field.charAt(0).toUpperCase() + r.field.slice(1))
        : r.newField;
      const val = vals[newFieldKey];
      const margin = (val && nettoPcs) ? (val - nettoPcs) : null;
      const marginPct = (val && nettoPcs) ? ((val - nettoPcs) / nettoPcs * 100) : null;
      return `<tr>
        <td class="jt-label">${r.label}</td>
        <td><input type="text" class="jual-input pc-hjual" data-idx="${itemIdx}" data-tier="${t}" data-field="${newFieldKey}"
                   value="${val ? fmt(val) : ''}" placeholder="—" inputmode="decimal" ${dis}></td>
        <td class="jt-pct"><span class="jual-margin-pct" data-idx="${itemIdx}" data-tier="${t}" data-field="${newFieldKey}">${marginPct != null ? marginPct.toFixed(1) + '%' : '—'}</span></td>
        <td class="jt-margin"><span class="jual-margin" data-idx="${itemIdx}" data-tier="${t}" data-field="${newFieldKey}">${margin != null ? fmt(margin) : '—'}</span></td>
      </tr>`;
    }).join('');
    return `<table class="jual-table"><thead><tr><th></th><th>Harga</th><th>Mrg%</th><th>Margin</th></tr></thead><tbody>${rowsHTML}</tbody></table>`;
  }

  function renderBundlingGroup(itemIdx, tier, b, nettoPcs) {
    const vals = {
      newHjual1: b.newHjual1, newHjual2: b.newHjual2, newHjual3: b.newHjual3,
      newHjual4: b.newHjual4, newHjual5: b.newHjual5, _enabled: true
    };
    const checked = b.enabled ? 'checked' : '';
    return `
      <div class="dp-jual-col dp-bundling-inline">
        <div class="dp-jual-col-header">
          <label class="bundling-toggle">
            <input type="checkbox" class="form-check-input pc-bundling-enable" data-idx="${itemIdx}" data-tier="${tier}" ${checked}>
            Bundling ${tier}
          </label>
          <span class="bundling-qty-wrap">Qty &ge;
            <input type="number" class="bundling-minqty pc-bundling-minqty" data-idx="${itemIdx}" data-tier="${tier}"
                   value="${b.minQty || ''}" placeholder="0" min="1" step="0.01" ${b.enabled ? '' : 'disabled'}>
            <span style="text-transform:none">Pcs</span>
          </span>
        </div>
        <div class="bundling-fields${b.enabled ? '' : ' bundling-fields-disabled'}" data-idx="${itemIdx}" data-tier="${tier}">
          ${renderJualTable(itemIdx, tier, vals, nettoPcs)}
        </div>
      </div>`;
  }

  // --- Search ---
  let searchTimer;
  let lastResults = [];

  function doSearch() {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (q.length < 2) { searchResults.classList.add('d-none'); lastResults = []; return; }
    searchTimer = setTimeout(() => {
      fetch(`/api/stock/search?q=${encodeURIComponent(q)}&mode=pc`)
        .then(r => r.json())
        .then(data => {
          lastResults = data.results || data || [];
          renderSearchResults(lastResults);
        });
    }, 300);
  }

  function renderSearchResults(results) {
    searchResults.innerHTML = '';
    results.forEach(m => {
      const scoreCls = m.score >= 90 ? 'text-primary fw-bold' : m.score >= 70 ? 'text-primary' : 'text-muted';
      const el = document.createElement('a');
      el.href = '#';
      el.className = 'list-group-item list-group-item-action';
      el.innerHTML = `
        <div class="d-flex justify-content-between align-items-start">
          <div>
            <div class="fw-semibold">${m.artname}</div>
            <small class="text-muted">${m.artno}${m.artpabrik ? ' | ' + m.artpabrik : ''}</small>
          </div>
          <span class="${scoreCls}" style="white-space:nowrap;margin-left:8px">${m.score?.toFixed(1) || ''}%</span>
        </div>`;
      el.addEventListener('click', (e) => {
        e.preventDefault();
        addItem(m);
        searchResults.classList.add('d-none');
        searchInput.value = '';
        searchInput.focus();
      });
      searchResults.appendChild(el);
    });
    searchResults.classList.toggle('d-none', !results.length);
  }

  searchInput.addEventListener('input', doSearch);

  // + button: add all search results (same as Enter)
  document.getElementById('pcBtnAdd').addEventListener('click', () => {
    if (lastResults.length) {
      lastResults.forEach(m => addItem(m));
      searchResults.classList.add('d-none');
      searchInput.value = '';
      searchInput.focus();
    }
  });

  // Enter: add ALL search results at once
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (lastResults.length) {
        lastResults.forEach(m => addItem(m));
        searchResults.classList.add('d-none');
        searchInput.value = '';
        searchInput.focus();
      }
    }
  });

  document.addEventListener('click', (e) => {
    if (!searchResults.contains(e.target) && e.target !== searchInput) {
      searchResults.classList.add('d-none');
    }
  });

  // Keyboard: Escape to collapse details
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('.modal.show')) {
      document.querySelectorAll('#pcTable .pc-main.has-detail-open').forEach(row => {
        row.click();
      });
    }
  });

  function addItem(match) {
    if (items.find(i => i.artno === match.artno)) return;
    const bundlings = match._bundlings || [];
    const b1 = bundlings[0] || {};
    const b2 = bundlings[1] || {};
    const item = {
      artno: match.artno,
      artname: match.artname || '',
      artpabrik: match.artpabrik || '',
      hbelibsr: match.hbelibsr || 0,
      hbelikcl: match.hbelikcl || 0,
      hbelinetto: match.hbelinetto || 0,
      packing: match.packing || 1,
      satbesar: match.satbesar || '',
      pctdisc1: match.pctdisc1 || 0,
      pctdisc2: match.pctdisc2 || 0,
      pctdisc3: match.pctdisc3 || 0,
      pctppn: match.pctppn || 0,
      hjual: match.hjual || 0,
      hjual2: match.hjual2 || 0,
      hjual3: match.hjual3 || 0,
      hjual4: match.hjual4 || 0,
      hjual5: match.hjual5 || 0,
      newHjual: match.hjual || 0,
      newHjual2: match.hjual2 || 0,
      newHjual3: match.hjual3 || 0,
      newHjual4: match.hjual4 || 0,
      newHjual5: match.hjual5 || 0,
      // Bundling 1
      bundling1: {
        enabled: !!(b1.qty),
        minQty: b1.qty || 0,
        hjual1: b1.hjual1 || 0, hjual2: b1.hjual2 || 0, hjual3: b1.hjual3 || 0,
        hjual4: b1.hjual4 || 0, hjual5: b1.hjual5 || 0,
        newHjual1: b1.hjual1 || 0, newHjual2: b1.hjual2 || 0, newHjual3: b1.hjual3 || 0,
        newHjual4: b1.hjual4 || 0, newHjual5: b1.hjual5 || 0,
      },
      // Bundling 2
      bundling2: {
        enabled: !!(b2.qty),
        minQty: b2.qty || 0,
        hjual1: b2.hjual1 || 0, hjual2: b2.hjual2 || 0, hjual3: b2.hjual3 || 0,
        hjual4: b2.hjual4 || 0, hjual5: b2.hjual5 || 0,
        newHjual1: b2.hjual1 || 0, newHjual2: b2.hjual2 || 0, newHjual3: b2.hjual3 || 0,
        newHjual4: b2.hjual4 || 0, newHjual5: b2.hjual5 || 0,
      },
    };
    items.push(item);
    render();
  }

  function render() {
    tableBody.innerHTML = '';

    if (items.length === 0) {
      tableBody.innerHTML = `<tr id="pcEmptyRow">
        <td colspan="4" class="text-center text-muted py-5">
          <i class="bi bi-inbox empty-state-icon"></i><br>
          <span class="mt-2 d-inline-block">Belum ada barang. Cari dari panel kiri.</span>
        </td>
      </tr>`;
      itemCount.textContent = '0 item';
      btnCommit.disabled = true;
      btnClear.disabled = true;
      return;
    }

    items.forEach((item, i) => {
      // --- Main row ---
      const tr = document.createElement('tr');
      tr.className = 'pc-main';
      tr.dataset.idx = i;

      tr.innerHTML = `
        <td class="row-num">
          <span class="expand-toggle"><i class="bi bi-chevron-right"></i></span>
          ${i + 1}
        </td>
        <td>
          <div><strong>${item.artname}</strong></div>
          <small class="text-muted"><code>${item.artno}</code> &middot; ${item.satbesar || ''} (${item.packing})</small>
        </td>
        <td><code>${item.artpabrik || ''}</code></td>
        <td>
          <button class="btn btn-sm btn-outline-danger btn-remove p-0 px-1 pc-remove" data-idx="${i}" title="Hapus">
            <i class="bi bi-x-lg"></i>
          </button>
        </td>
      `;
      tableBody.appendChild(tr);

      // --- Detail row (expandable) ---
      const detailTr = document.createElement('tr');
      detailTr.className = 'pc-detail';
      detailTr.dataset.idx = i;

      const sat = item.satbesar || 'Bsr';
      const pack = item.packing || 1;
      const net = calcNetPrice(item.hbelibsr, item.pctdisc1, item.pctdisc2, item.pctdisc3, item.pctppn);
      const nettoBsr = net.final;
      const nettoPcs = pack > 0 ? nettoBsr / pack : 0;

      // Main jual values
      const mainJualVals = {
        newHjual: item.newHjual, newHjual2: item.newHjual2, newHjual3: item.newHjual3,
        newHjual4: item.newHjual4, newHjual5: item.newHjual5
      };

      detailTr.innerHTML = `
        <td colspan="4">
          <div class="dp-grid">
            <!-- Harga Beli -->
            <div class="dp-section dp-beli">
              <div class="dp-section-header">Harga Beli</div>
              <div class="dp-beli-row">
                <span class="dp-label">Beli</span>
                <span class="dp-val">${fmt(item.hbelibsr)}</span><span class="dp-unit">/${sat}</span>
                <span class="dp-val">${fmt(item.hbelikcl)}</span><span class="dp-unit">/Pcs</span>
              </div>
              <table class="beli-table">
                <thead>
                  <tr>
                    <th></th>
                    <th class="dp-th-total">/${sat} &times; 1 =</th>
                    <th>/${sat}</th>
                    <th>%</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td class="bt-label">Diskon 1</td>
                    <td class="text-end text-muted">${net.disc1Amt ? fmt(net.disc1Amt) : '0'}</td>
                    <td class="text-end text-muted">${net.disc1Amt ? fmt(net.disc1Amt) : '0'}</td>
                    <td class="text-end text-muted">${item.pctdisc1 || '—'}</td>
                  </tr>
                  <tr>
                    <td class="bt-label">Diskon 2</td>
                    <td class="text-end text-muted">${net.disc2Amt ? fmt(net.disc2Amt) : '0'}</td>
                    <td class="text-end text-muted">${net.disc2Amt ? fmt(net.disc2Amt) : '0'}</td>
                    <td class="text-end text-muted">${item.pctdisc2 || '—'}</td>
                  </tr>
                  <tr>
                    <td class="bt-label">PPN</td>
                    <td class="text-end text-muted">${net.ppnAmt ? fmt(net.ppnAmt) : '0'}</td>
                    <td class="text-end text-muted">${net.ppnAmt ? fmt(net.ppnAmt) : '0'}</td>
                    <td class="text-end text-muted">${item.pctppn || '—'}</td>
                  </tr>
                  <tr>
                    <td class="bt-label">Diskon 3</td>
                    <td class="text-end text-muted">${net.disc3Amt ? fmt(net.disc3Amt) : '0'}</td>
                    <td class="text-end text-muted">${net.disc3Amt ? fmt(net.disc3Amt) : '0'}</td>
                    <td class="text-end text-muted">${item.pctdisc3 || '—'}</td>
                  </tr>
                </tbody>
              </table>
              <div class="beli-row-foc">
                <span class="bt-label">F.O.C</span>
                <span class="text-muted">0</span>
                <span class="bt-unit">Pcs</span>
              </div>
              <div class="beli-row-shipping">
                <span class="bt-label">B.Kirim</span>
                <span class="text-muted">0</span>
              </div>
              <div class="dp-netto-row">
                <span class="dp-label">Netto</span>
                <span class="dp-netto-val">${fmtNz(nettoBsr)}</span><span class="dp-unit">/${sat}</span>
                <span class="dp-netto-val">${fmtNz(nettoPcs)}</span><span class="dp-unit">/Pcs</span>
              </div>
            </div>
            <!-- Harga Jual -->
            <div class="dp-section dp-jual-wrapper">
              <div class="dp-section-header">Harga Jual</div>
              <div class="dp-jual-row">
                <div class="dp-jual-col">
                  <div class="dp-jual-col-header">Satuan</div>
                  ${renderJualTable(i, null, mainJualVals, nettoPcs)}
                </div>
                ${renderBundlingGroup(i, 1, item.bundling1, nettoPcs)}
                ${renderBundlingGroup(i, 2, item.bundling2, nettoPcs)}
              </div>
            </div>
          </div>
        </td>
      `;
      tableBody.appendChild(detailTr);
    });

    itemCount.textContent = items.length + ' item';
    btnCommit.disabled = items.length === 0;
    btnClear.disabled = items.length === 0;
    bindEvents();
  }

  function bindEvents() {
    // Toggle detail row on main row click
    document.querySelectorAll('.pc-main').forEach(mainRow => {
      mainRow.addEventListener('click', (e) => {
        if (e.target.closest('button, input, select, a')) return;
        const detailRow = mainRow.nextElementSibling;
        if (detailRow && detailRow.classList.contains('pc-detail')) {
          detailRow.classList.toggle('open');
          mainRow.classList.toggle('has-detail-open');
        }
      });
    });

    // Hjual inputs
    document.querySelectorAll('.pc-hjual').forEach(el => {
      el.addEventListener('click', (e) => e.stopPropagation());
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        const tier = el.dataset.tier;
        const field = el.dataset.field;
        const newVal = parseNum(el.value);

        if (tier === 'main') {
          items[idx][field] = newVal;
        } else {
          const bKey = `bundling${tier}`;
          items[idx][bKey][field] = newVal;
        }

        el.value = newVal ? fmt(newVal) : '';

        // Update margin displays
        const item = items[idx];
        const pack = item.packing || 1;
        const net = calcNetPrice(item.hbelibsr, item.pctdisc1, item.pctdisc2, item.pctdisc3, item.pctppn);
        const nettoPcs = pack > 0 ? net.final / pack : 0;

        if (nettoPcs) {
          const margin = newVal - nettoPcs;
          const marginPct = (margin / nettoPcs * 100);
          const pctEl = document.querySelector(`.jual-margin-pct[data-idx="${idx}"][data-tier="${tier}"][data-field="${field}"]`);
          const mrgEl = document.querySelector(`.jual-margin[data-idx="${idx}"][data-tier="${tier}"][data-field="${field}"]`);
          if (pctEl) pctEl.textContent = newVal ? marginPct.toFixed(1) + '%' : '—';
          if (mrgEl) mrgEl.textContent = newVal ? fmt(margin) : '—';
        }

        // Update main row display
        updateMainRow(idx);
      });
    });

    // Bundling enable checkboxes
    document.querySelectorAll('.pc-bundling-enable').forEach(el => {
      el.addEventListener('click', (e) => e.stopPropagation());
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        const tier = el.dataset.tier;
        const bKey = `bundling${tier}`;
        items[idx][bKey].enabled = el.checked;
        // Toggle disabled state on fields
        const fields = document.querySelector(`.bundling-fields[data-idx="${idx}"][data-tier="${tier}"]`);
        if (fields) fields.classList.toggle('bundling-fields-disabled', !el.checked);
        const minqty = document.querySelector(`.pc-bundling-minqty[data-idx="${idx}"][data-tier="${tier}"]`);
        if (minqty) minqty.disabled = !el.checked;
        // Toggle disabled on jual inputs within
        fields?.querySelectorAll('.pc-hjual').forEach(inp => inp.disabled = !el.checked);
      });
    });

    // Bundling minqty inputs
    document.querySelectorAll('.pc-bundling-minqty').forEach(el => {
      el.addEventListener('click', (e) => e.stopPropagation());
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.idx);
        const tier = el.dataset.tier;
        items[idx][`bundling${tier}`].minQty = parseFloat(el.value) || 0;
      });
    });

    // Remove buttons
    document.querySelectorAll('.pc-remove').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        items.splice(parseInt(el.dataset.idx), 1);
        render();
      });
    });
  }

  function updateMainRow(idx) {
    // Main row no longer has price columns — no-op
  }

  // Commit
  btnCommit.addEventListener('click', async () => {
    const changed = items.filter(i => {
      const mainChanged = i.newHjual !== i.hjual || i.newHjual2 !== i.hjual2 ||
        i.newHjual3 !== i.hjual3 || i.newHjual4 !== i.hjual4 || i.newHjual5 !== i.hjual5;
      const b1Changed = i.bundling1.enabled && (
        i.bundling1.newHjual1 !== i.bundling1.hjual1 || i.bundling1.newHjual2 !== i.bundling1.hjual2 ||
        i.bundling1.newHjual3 !== i.bundling1.hjual3 || i.bundling1.newHjual4 !== i.bundling1.hjual4 || i.bundling1.newHjual5 !== i.bundling1.hjual5);
      const b2Changed = i.bundling2.enabled && (
        i.bundling2.newHjual1 !== i.bundling2.hjual1 || i.bundling2.newHjual2 !== i.bundling2.hjual2 ||
        i.bundling2.newHjual3 !== i.bundling2.hjual3 || i.bundling2.newHjual4 !== i.bundling2.hjual4 || i.bundling2.newHjual5 !== i.bundling2.hjual5);
      return mainChanged || b1Changed || b2Changed;
    });
    if (!changed.length) {
      window.showToast && showToast('Tidak ada perubahan harga', 'warning');
      return;
    }

    const confirmed = await (window.showConfirm
      ? showConfirm(`Simpan perubahan harga untuk ${changed.length} item?`)
      : Promise.resolve(confirm(`Simpan perubahan harga untuk ${changed.length} item?`)));
    if (!confirmed) return;

    btnCommit.disabled = true;
    try {
      const payload = changed.map(i => {
        const p = {
          artno: i.artno,
          hjual: i.newHjual,
          hjual2: i.newHjual2,
          hjual3: i.newHjual3,
          hjual4: i.newHjual4,
          hjual5: i.newHjual5,
        };
        if (i.bundling1.enabled) {
          p.bundling1 = {
            minQty: i.bundling1.minQty,
            hjual1: i.bundling1.newHjual1, hjual2: i.bundling1.newHjual2, hjual3: i.bundling1.newHjual3,
            hjual4: i.bundling1.newHjual4, hjual5: i.bundling1.newHjual5,
          };
        }
        if (i.bundling2.enabled) {
          p.bundling2 = {
            minQty: i.bundling2.minQty,
            hjual1: i.bundling2.newHjual1, hjual2: i.bundling2.newHjual2, hjual3: i.bundling2.newHjual3,
            hjual4: i.bundling2.newHjual4, hjual5: i.bundling2.newHjual5,
          };
        }
        return p;
      });
      const purchEl = document.getElementById('pcUpdatePurchPrice');
      const lockEl = document.getElementById('pcLockHistory');
      const updatePurchPrice = purchEl ? purchEl.checked : true;
      const lockHistory = lockEl ? lockEl.checked : true;
      const res = await fetch('/api/price-change/commit', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({items: payload, update_purch_price: updatePurchPrice, lock_history: lockHistory}),
      });
      const data = await res.json();
      if (data.ok) {
        document.getElementById('pcSuccessNumber').textContent = data.ph_number;
        document.getElementById('pcSuccessCount').textContent = data.item_count;
        new bootstrap.Modal(document.getElementById('pcSuccessModal')).show();
      } else {
        window.showToast && showToast('Gagal: ' + (data.error || 'Unknown'), 'danger');
      }
    } catch (e) {
      window.showToast && showToast('Error: ' + e.message, 'danger');
    }
    btnCommit.disabled = false;
  });

  // New entry after success
  document.getElementById('pcBtnNew').addEventListener('click', () => {
    items.length = 0;
    render();
    bootstrap.Modal.getInstance(document.getElementById('pcSuccessModal'))?.hide();
    searchInput.focus();
  });

  // Clear all
  btnClear.addEventListener('click', async () => {
    const confirmed = await (window.showConfirm
      ? showConfirm(`Hapus semua ${items.length} item?`)
      : Promise.resolve(confirm(`Hapus semua ${items.length} item?`)));
    if (!confirmed) return;
    items.length = 0;
    render();
    searchInput.focus();
  });
})();
