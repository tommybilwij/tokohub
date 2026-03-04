/**
 * Scanner Page - Barcode scanner + stock lookup
 */
(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // DOM refs
  // -----------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const dom = {
    viewport:       $('#scannerViewport'),
    btnToggle:      $('#btnToggleCamera'),
    cameraSelect:   $('#cameraSelect'),
    placeholder:    $('.scanner-placeholder'),
    crosshair:      $('.scanner-crosshair'),
    searchInput:    $('#searchInput'),
    searchDropdown: $('#searchDropdown'),
    barcodeAlert:   $('#barcodeAlert'),
    barcodeValue:   $('#barcodeValue'),
    stockDetail:    $('#stockDetail'),
    noResultCard:   $('#noResultCard'),
    // stock detail fields
    sdArtname:      $('#sdArtname'),
    sdArtno:        $('#sdArtno'),
    sdBarcode:      $('#sdBarcode'),
    sdPacking:      $('#sdPacking'),
    sdSatuan:       $('#sdSatuan'),
    sdStockBanner:  $('#sdStockBanner'),
    sdStockLoading: $('#sdStockLoading'),
    sdStockBalances:$('#sdStockBalances'),
    sdHbeliBsr:     $('#sdHbeliBsr'),
    sdHbeliKcl:     $('#sdHbeliKcl'),
    sdDisc1:        $('#sdDisc1'),
    sdDisc2:        $('#sdDisc2'),
    sdDisc3:        $('#sdDisc3'),
    sdPPN:          $('#sdPPN'),
    sdNetto:        $('#sdNetto'),
    sdJualBody:     $('#sdJualBody'),
    sdBundlingSection: $('#sdBundlingSection'),
    sdBundlingBody: $('#sdBundlingBody'),
  };

  // Guard: only run on scanner page
  if (!dom.viewport) return;

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------
  let cameraRunning = false;
  let lastDetectedTime = 0;
  const COOLDOWN_MS = 2000;
  let pendingCode = null;
  let pendingCount = 0;
  const CONFIRM_COUNT = 2;

  // -----------------------------------------------------------------------
  // Sharpening filter
  // -----------------------------------------------------------------------
  var PROC_W = 640;
  var PROC_H = 480;
  var procCanvas = document.createElement('canvas');
  procCanvas.width = PROC_W;
  procCanvas.height = PROC_H;
  var procCtx = procCanvas.getContext('2d', { willReadFrequently: true });

  function sharpenFrame() {
    var img = procCtx.getImageData(0, 0, PROC_W, PROC_H);
    var s = img.data;
    var d = new Uint8ClampedArray(s.length);
    var stride = PROC_W * 4;
    d.set(s);
    for (var y = 1; y < PROC_H - 1; y++) {
      for (var x = 1; x < PROC_W - 1; x++) {
        var p = y * stride + x * 4;
        for (var c = 0; c < 3; c++) {
          // Kernel: [0,-1,0,-1,5,-1,0,-1,0]
          d[p + c] = Math.max(0, Math.min(255,
            5 * s[p + c]
            - s[p - stride + c]
            - s[p + stride + c]
            - s[p - 4 + c]
            - s[p + 4 + c]
          ));
        }
        d[p + 3] = 255;
      }
    }
    procCtx.putImageData(new ImageData(d, PROC_W, PROC_H), 0, 0);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------
  function fmt(n) {
    if (n == null || isNaN(n)) return '-';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtQty(n) {
    if (n == null || isNaN(n)) return '-';
    var v = Number(n);
    return v % 1 === 0
      ? v.toLocaleString('en-US')
      : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }

  function fmtPct(n) {
    if (!n) return '-';
    return Number(n).toFixed(2) + '%';
  }

  // -----------------------------------------------------------------------
  // Camera (manual stream + sharpened decode)
  // -----------------------------------------------------------------------
  var mediaStream = null;
  var videoEl = null;
  var decodeInterval = null;
  var isDecoding = false;
  var DECODE_READERS = ['ean_reader', 'ean_8_reader', 'upc_reader', 'code_128_reader', 'code_39_reader'];

  async function populateCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videos = devices.filter(d => d.kind === 'videoinput');
      if (videos.length > 1) {
        dom.cameraSelect.innerHTML = videos.map((d, i) =>
          `<option value="${d.deviceId}">${d.label || 'Camera ' + (i + 1)}</option>`
        ).join('');
        dom.cameraSelect.classList.remove('d-none');
      }
    } catch (e) {
      // ignore
    }
  }

  function startCamera() {
    var deviceId = dom.cameraSelect.value || undefined;
    var vConstraints = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      : { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } };

    navigator.mediaDevices.getUserMedia({ video: vConstraints }).then(function (stream) {
      mediaStream = stream;
      videoEl = document.createElement('video');
      videoEl.setAttribute('playsinline', '');
      videoEl.setAttribute('autoplay', '');
      videoEl.muted = true;
      videoEl.style.width = '100%';
      videoEl.style.display = 'block';
      videoEl.srcObject = stream;
      dom.viewport.appendChild(videoEl);

      cameraRunning = true;
      dom.placeholder.classList.add('d-none');
      dom.crosshair.classList.remove('d-none');
      dom.btnToggle.innerHTML = '<i class="bi bi-stop-fill"></i> Stop';
      dom.btnToggle.classList.replace('btn-light', 'btn-danger');
      populateCameras();

      decodeInterval = setInterval(processFrame, 100);
    }).catch(function (err) {
      console.error('Camera error:', err);
      alert('Gagal akses kamera: ' + (err.message || err));
    });
  }

  function stopCamera() {
    if (decodeInterval) { clearInterval(decodeInterval); decodeInterval = null; }
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) { t.stop(); });
      mediaStream = null;
    }
    if (videoEl) { videoEl.remove(); videoEl = null; }
    cameraRunning = false;
    isDecoding = false;
    dom.placeholder.classList.remove('d-none');
    dom.crosshair.classList.add('d-none');
    dom.btnToggle.innerHTML = '<i class="bi bi-play-fill"></i> Start';
    dom.btnToggle.classList.replace('btn-danger', 'btn-light');
  }

  function processFrame() {
    if (!videoEl || videoEl.readyState < 2 || isDecoding) return;

    // Draw downsampled frame to processing canvas
    procCtx.drawImage(videoEl, 0, 0, PROC_W, PROC_H);
    // Apply sharpening convolution
    sharpenFrame();

    isDecoding = true;
    var dataUrl = procCanvas.toDataURL('image/jpeg', 0.85);
    Quagga.decodeSingle({
      src: dataUrl,
      decoder: { readers: DECODE_READERS, multiple: false },
      locate: true,
    }, function (result) {
      isDecoding = false;
      if (result && result.codeResult && result.codeResult.code) {
        onBarcodeDetected(result);
      }
    });
  }

  dom.btnToggle.addEventListener('click', function () {
    if (cameraRunning) {
      stopCamera();
    } else {
      startCamera();
    }
  });

  dom.cameraSelect.addEventListener('change', function () {
    if (cameraRunning) {
      stopCamera();
      startCamera();
    }
  });

  // -----------------------------------------------------------------------
  // Barcode detection
  // -----------------------------------------------------------------------
  function onBarcodeDetected(result) {
    const now = Date.now();
    if (now - lastDetectedTime < COOLDOWN_MS) return;

    const code = result.codeResult.code;
    if (!code) return;

    // Require CONFIRM_COUNT consecutive same reads to reduce false positives
    if (code === pendingCode) {
      pendingCount++;
    } else {
      pendingCode = code;
      pendingCount = 1;
    }
    if (pendingCount < CONFIRM_COUNT) return;

    // Confirmed detection
    lastDetectedTime = now;
    pendingCode = null;
    pendingCount = 0;

    if (navigator.vibrate) navigator.vibrate(100);

    dom.searchInput.value = code;
    lookupBarcode(code);
  }

  async function lookupBarcode(code) {
    showBarcodeAlert(code);
    hideResults();

    try {
      const res = await fetch(`/api/stock/search?q=${encodeURIComponent(code)}&limit=1`);
      const data = await res.json();
      hideBarcodeAlert();

      if (data.length > 0 && data[0].match_type === 'barcode') {
        displayStockDetail(data[0]);
      } else if (data.length > 0) {
        displayStockDetail(data[0]);
      } else {
        showNoResult();
      }
    } catch (e) {
      hideBarcodeAlert();
      console.error('Lookup failed:', e);
      showNoResult();
    }
  }

  // -----------------------------------------------------------------------
  // Text search (debounced)
  // -----------------------------------------------------------------------
  let searchTimer = null;

  dom.searchInput.addEventListener('input', function () {
    const q = this.value.trim();
    clearTimeout(searchTimer);
    if (!q) {
      dom.searchDropdown.classList.add('d-none');
      return;
    }
    searchTimer = setTimeout(() => textSearch(q), 300);
  });

  dom.searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchTimer);
      const q = this.value.trim();
      if (q) textSearch(q);
    }
  });

  // Close dropdown on outside click
  document.addEventListener('click', function (e) {
    if (!dom.searchDropdown.contains(e.target) && e.target !== dom.searchInput) {
      dom.searchDropdown.classList.add('d-none');
    }
  });

  async function textSearch(query) {
    try {
      const res = await fetch(`/api/stock/search?q=${encodeURIComponent(query)}&limit=10`);
      const data = await res.json();

      if (!data.length) {
        dom.searchDropdown.classList.add('d-none');
        return;
      }

      dom.searchDropdown.innerHTML = data.map((item, i) => `
        <button type="button" class="list-group-item list-group-item-action" data-idx="${i}">
          <div class="d-flex justify-content-between align-items-start">
            <div>
              <div class="fw-semibold" style="font-size:var(--fs-base)">${esc(item.artname)}</div>
              <small class="text-muted" style="font-family:monospace">${esc(item.artno)}</small>
            </div>
            <span class="badge ${item.score >= 85 ? 'bg-primary' : item.score >= 60 ? 'bg-warning text-dark' : 'bg-secondary'}"
                  style="font-size:var(--fs-2xs)">${item.score}${item.match_type === 'barcode' ? ' BC' : item.match_type === 'alias' ? ' AL' : ''}</span>
          </div>
        </button>
      `).join('');

      // Store data for click handler
      dom.searchDropdown._data = data;
      dom.searchDropdown.classList.remove('d-none');
    } catch (e) {
      console.error('Search failed:', e);
    }
  }

  dom.searchDropdown.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-idx]');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx);
    const data = dom.searchDropdown._data;
    if (data && data[idx]) {
      dom.searchDropdown.classList.add('d-none');
      dom.searchInput.value = data[idx].artname;
      displayStockDetail(data[idx]);
    }
  });

  // -----------------------------------------------------------------------
  // Display stock detail
  // -----------------------------------------------------------------------
  function displayStockDetail(item) {
    hideResults();

    dom.sdArtname.textContent = item.artname || '-';
    dom.sdArtno.textContent = item.artno || '-';
    dom.sdBarcode.textContent = item.artpabrik || '-';
    dom.sdPacking.textContent = item.packing ? (Math.round(item.packing) + ' ' + (item.satkecil || '')) : '-';
    dom.sdSatuan.textContent = (item.satbesar || '-') + ' / ' + (item.satkecil || '-');

    // Harga Beli
    dom.sdHbeliBsr.textContent = fmt(item.hbelibsr);
    dom.sdHbeliKcl.textContent = fmt(item.hbelikcl);
    dom.sdDisc1.textContent = fmtPct(item.pctdisc1);
    dom.sdDisc2.textContent = fmtPct(item.pctdisc2);
    dom.sdDisc3.textContent = fmtPct(item.pctdisc3);
    dom.sdPPN.textContent = fmtPct(item.pctppn);

    // Calculate Netto
    let netto = item.hbelikcl || 0;
    if (item.pctdisc1) netto *= (1 - item.pctdisc1 / 100);
    if (item.pctdisc2) netto *= (1 - item.pctdisc2 / 100);
    if (item.pctdisc3) netto *= (1 - item.pctdisc3 / 100);
    if (item.pctppn) netto *= (1 + item.pctppn / 100);
    dom.sdNetto.textContent = fmt(Math.round(netto));

    // Harga Jual table
    const tiers = [
      { label: 'H.Jual 1', val: item.hjual },
      { label: 'Member', val: item.hjual2 },
      { label: 'H.Jual 3', val: item.hjual3 },
      { label: 'H.Jual 4', val: item.hjual4 },
      { label: 'H.Jual 5', val: item.hjual5 },
    ];
    dom.sdJualBody.innerHTML = tiers.map(t => {
      const hasMargin = t.val > 0 && netto > 0;
      const margin = hasMargin ? (((t.val - netto) / netto) * 100).toFixed(2) + '%' : '-';
      const marginClass = (hasMargin && t.val < netto) ? 'text-danger' : '';
      return `<tr>
        <td>${t.label}</td>
        <td class="text-end">${fmt(t.val)}</td>
        <td class="text-end ${marginClass}">${margin}</td>
      </tr>`;
    }).join('');

    // Bundling
    const bundlings = item._bundlings || [];
    if (bundlings.length > 0) {
      dom.sdBundlingSection.classList.remove('d-none');
      dom.sdBundlingBody.innerHTML = bundlings.map(b => `<tr>
        <td>${b.qty}</td>
        <td class="text-end">${fmt(b.hjual1)}</td>
        <td class="text-end">${fmt(b.hjual2)}</td>
        <td class="text-end">${fmt(b.hjual3)}</td>
        <td class="text-end">${fmt(b.hjual4)}</td>
        <td class="text-end">${fmt(b.hjual5)}</td>
      </tr>`).join('');
    } else {
      dom.sdBundlingSection.classList.add('d-none');
    }

    dom.stockDetail.classList.remove('d-none');

    // Fetch stock balance
    fetchBalance(item.artno, item.satkecil);
  }

  async function fetchBalance(artno, satkecil) {
    dom.sdStockLoading.classList.remove('d-none');
    dom.sdStockBalances.innerHTML = '';

    try {
      const res = await fetch(`/api/stock/balance/${encodeURIComponent(artno)}`);
      const rows = await res.json();
      dom.sdStockLoading.classList.add('d-none');

      if (rows.length === 0) {
        dom.sdStockBalances.innerHTML = '<div class="text-muted" style="font-size:var(--fs-sm)">Tidak ada data stok</div>';
        return;
      }

      dom.sdStockBalances.innerHTML = rows.map(r =>
        `<div class="sd-balance-row">
          <span class="sd-balance-wh">${esc(r.warehouseid || 'DEFAULT')}</span>
          <span class="sd-balance-qty">${fmtQty(r.curqty)} <small class="sd-balance-unit">${esc(satkecil || '')}</small></span>
        </div>`
      ).join('');
    } catch (e) {
      dom.sdStockLoading.classList.add('d-none');
      dom.sdStockBalances.innerHTML = '<div class="text-danger" style="font-size:var(--fs-sm)">Gagal memuat stok</div>';
    }
  }

  // -----------------------------------------------------------------------
  // UI helpers
  // -----------------------------------------------------------------------
  function showBarcodeAlert(code) {
    dom.barcodeValue.textContent = code;
    dom.barcodeAlert.classList.remove('d-none');
  }

  function hideBarcodeAlert() {
    dom.barcodeAlert.classList.add('d-none');
  }

  function hideResults() {
    dom.stockDetail.classList.add('d-none');
    dom.noResultCard.classList.add('d-none');
    dom.sdBundlingSection.classList.add('d-none');
  }

  function showNoResult() {
    dom.noResultCard.classList.remove('d-none');
    dom.stockDetail.classList.add('d-none');
  }

  function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

})();
