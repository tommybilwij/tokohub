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
    const item = {
      artno: match.artno,
      artname: match.artname || '',
      hbelibsr: match.hbelibsr || 0,
      hbelikcl: match.hbelikcl || 0,
      hbelinetto: match.hbelinetto || 0,
      packing: match.packing || 1,
      satbesar: match.satbesar || '',
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
    };
    items.push(item);
    render();
  }

  function render() {
    tableBody.innerHTML = '';

    if (items.length === 0) {
      tableBody.innerHTML = `<tr id="pcEmptyRow">
        <td colspan="7" class="text-center text-muted py-5">
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

      const hjualChanged = item.newHjual !== item.hjual;
      const hjual2Changed = item.newHjual2 !== item.hjual2;

      tr.innerHTML = `
        <td class="row-num">
          <span class="expand-toggle"><i class="bi bi-chevron-right"></i></span>
          ${i + 1}
        </td>
        <td>
          <div><strong>${item.artname}</strong></div>
          <small class="text-muted"><code>${item.artno}</code> &middot; ${item.satbesar || ''} (${item.packing})</small>
        </td>
        <td class="text-end">${fmt(item.hbelibsr)}</td>
        <td class="text-end">${fmtNz(item.hbelinetto)}</td>
        <td class="text-end ${hjualChanged ? 'text-danger fw-bold' : ''}">${fmt(item.newHjual)}</td>
        <td class="text-end ${hjual2Changed ? 'text-danger fw-bold' : ''}">${fmtNz(item.newHjual2)}</td>
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

      detailTr.innerHTML = `
        <td colspan="7">
          <div class="dp-grid">
            <div class="dp-section dp-beli">
              <div class="dp-section-header">Info Harga Beli</div>
              <table class="table table-sm table-borderless mb-0" style="max-width:400px">
                <tr><td class="text-muted" style="width:120px">Beli/Bsr</td><td class="text-end">${fmt(item.hbelibsr)}</td></tr>
                <tr><td class="text-muted">Beli/Pcs</td><td class="text-end">${fmt(item.hbelikcl)}</td></tr>
                <tr><td class="text-muted">Netto/Pcs</td><td class="text-end">${fmtNz(item.hbelinetto)}</td></tr>
                <tr><td class="text-muted">Packing</td><td class="text-end">${item.packing}</td></tr>
              </table>
            </div>
            <div class="dp-section dp-jual-wrapper">
              <div class="dp-section-header">Harga Jual</div>
              <table class="table table-sm mb-0">
                <thead class="table-light">
                  <tr>
                    <th></th>
                    <th class="text-end">Lama</th>
                    <th class="text-end">Baru</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td class="fw-semibold">Jual 1</td>
                    <td class="text-end text-muted">${fmt(item.hjual)}</td>
                    <td><input type="text" class="form-control form-control-sm text-end pc-hjual" data-idx="${i}" data-field="newHjual" value="${fmt(item.newHjual)}" inputmode="decimal"></td>
                  </tr>
                  <tr>
                    <td class="fw-semibold">Member</td>
                    <td class="text-end text-muted">${fmtNz(item.hjual2)}</td>
                    <td><input type="text" class="form-control form-control-sm text-end pc-hjual" data-idx="${i}" data-field="newHjual2" value="${item.newHjual2 ? fmt(item.newHjual2) : ''}" inputmode="decimal"></td>
                  </tr>
                  <tr>
                    <td class="fw-semibold">Jual 3</td>
                    <td class="text-end text-muted">${fmtNz(item.hjual3)}</td>
                    <td><input type="text" class="form-control form-control-sm text-end pc-hjual" data-idx="${i}" data-field="newHjual3" value="${item.newHjual3 ? fmt(item.newHjual3) : ''}" inputmode="decimal"></td>
                  </tr>
                  <tr>
                    <td class="fw-semibold">Jual 4</td>
                    <td class="text-end text-muted">${fmtNz(item.hjual4)}</td>
                    <td><input type="text" class="form-control form-control-sm text-end pc-hjual" data-idx="${i}" data-field="newHjual4" value="${item.newHjual4 ? fmt(item.newHjual4) : ''}" inputmode="decimal"></td>
                  </tr>
                  <tr>
                    <td class="fw-semibold">Jual 5</td>
                    <td class="text-end text-muted">${fmtNz(item.hjual5)}</td>
                    <td><input type="text" class="form-control form-control-sm text-end pc-hjual" data-idx="${i}" data-field="newHjual5" value="${item.newHjual5 ? fmt(item.newHjual5) : ''}" inputmode="decimal"></td>
                  </tr>
                </tbody>
              </table>
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
        const field = el.dataset.field;
        items[idx][field] = parseNum(el.value);
        el.value = items[idx][field] ? fmt(items[idx][field]) : '';
        // Update main row display
        updateMainRow(idx);
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
    const item = items[idx];
    const mainRow = document.querySelector(`.pc-main[data-idx="${idx}"]`);
    if (!mainRow) return;
    const tds = mainRow.querySelectorAll('td');
    // HJual 1 column (index 4)
    const hjualChanged = item.newHjual !== item.hjual;
    tds[4].className = 'text-end ' + (hjualChanged ? 'text-danger fw-bold' : '');
    tds[4].textContent = fmt(item.newHjual);
    // Member column (index 5)
    const hjual2Changed = item.newHjual2 !== item.hjual2;
    tds[5].className = 'text-end ' + (hjual2Changed ? 'text-danger fw-bold' : '');
    tds[5].textContent = fmtNz(item.newHjual2);
  }

  // Commit
  btnCommit.addEventListener('click', async () => {
    const changed = items.filter(i =>
      i.newHjual !== i.hjual || i.newHjual2 !== i.hjual2 ||
      i.newHjual3 !== i.hjual3 || i.newHjual4 !== i.hjual4 || i.newHjual5 !== i.hjual5
    );
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
      const payload = changed.map(i => ({
        artno: i.artno,
        hjual: i.newHjual,
        hjual2: i.newHjual2,
        hjual3: i.newHjual3,
        hjual4: i.newHjual4,
        hjual5: i.newHjual5,
      }));
      const res = await fetch('/api/price-change/commit', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({items: payload}),
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
