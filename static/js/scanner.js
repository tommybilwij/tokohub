/**
 * Scanner Page - Barcode scanner + stock lookup
 *
 * Detection: Quagga2 (JS-based) with multi-pass config cycling.
 * Anti-shake: requires CONFIRM_COUNT consecutive identical reads before accepting.
 * Center-crop: only scans the middle portion of the frame for faster, more accurate reads.
 */
(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // DOM refs
  // -----------------------------------------------------------------------
  var $ = function(sel) { return document.querySelector(sel); };
  var dom = {
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

  if (!dom.viewport) return;

  // -----------------------------------------------------------------------
  // Permissions (from server-rendered data attributes)
  // -----------------------------------------------------------------------
  var scannerPage = document.querySelector('.scanner-page');
  var SHOW_BELI = scannerPage.dataset.showBeli === 'true';
  var SHOW_JUAL = scannerPage.dataset.showJual === 'true';
  var SHOW_MARGIN = scannerPage.dataset.showMargin === 'true';

  // -----------------------------------------------------------------------
  // Config
  // -----------------------------------------------------------------------
  var COOLDOWN_MS = 2000;
  var CONFIRM_COUNT = 2;
  var CROP_RATIO = 0.8;        // scan center 80% of frame width
  var CROP_HEIGHT_RATIO = 0.5;  // scan center 50% of frame height
  var SCAN_INTERVAL_MS = 80;    // min ms between decode attempts

  // Quagga processing canvas — 800x600 gives enough detail for reliable decode
  var PROC_W = 800;
  var PROC_H = 600;
  var procCanvas = document.createElement('canvas');
  procCanvas.width = PROC_W;
  procCanvas.height = PROC_H;
  var procCtx = procCanvas.getContext('2d', { willReadFrequently: true });

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------
  var cameraRunning = false;
  var lastDetectedTime = 0;
  var pendingCode = null;
  var pendingCount = 0;
  var mediaStream = null;
  var videoEl = null;
  var scanRAF = null;
  var lastScanTime = 0;
  var isDecoding = false;
  var torchOn = false;
  var torchTrack = null;
  // Quagga readers
  var QUAGGA_READERS = ['ean_reader', 'ean_8_reader', 'upc_reader', 'upc_e_reader', 'code_128_reader', 'code_39_reader', 'i2of5_reader', 'codabar_reader'];

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

  function esc(str) {
    if (!str) return '';
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // -----------------------------------------------------------------------
  // Camera management
  // -----------------------------------------------------------------------
  function populateCameras() {
    navigator.mediaDevices.enumerateDevices().then(function(devices) {
      var videos = devices.filter(function(d) { return d.kind === 'videoinput'; });
      if (videos.length > 1) {
        dom.cameraSelect.innerHTML = videos.map(function(d, i) {
          return '<option value="' + d.deviceId + '">' + (d.label || 'Camera ' + (i + 1)) + '</option>';
        }).join('');
        dom.cameraSelect.classList.remove('d-none');
      }
    }).catch(function() {});
  }

  function startCamera() {
    var deviceId = dom.cameraSelect.value || undefined;
    var vConstraints = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      : { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } };

    navigator.mediaDevices.getUserMedia({ video: vConstraints }).then(function(stream) {
      mediaStream = stream;
      videoEl = document.createElement('video');
      videoEl.setAttribute('playsinline', '');
      videoEl.setAttribute('autoplay', '');
      videoEl.muted = true;
      videoEl.style.width = '100%';
      videoEl.style.display = 'block';
      videoEl.srcObject = stream;
      dom.viewport.appendChild(videoEl);

      // Check torch capability
      var track = stream.getVideoTracks()[0];
      torchTrack = track;
      var caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.torch) {
        showTorchButton();
      }

      cameraRunning = true;
      dom.placeholder.classList.add('d-none');
      dom.crosshair.classList.remove('d-none');
      dom.btnToggle.innerHTML = '<i class="bi bi-stop-fill"></i> Stop';
      dom.btnToggle.classList.replace('btn-light', 'btn-danger');
      populateCameras();

      // Start scan loop
      scanRAF = requestAnimationFrame(scanLoop);
    }).catch(function(err) {
      console.error('Camera error:', err);
      window.showToast ? showToast('Gagal akses kamera: ' + (err.message || err), 'danger') : alert('Gagal akses kamera: ' + (err.message || err));
    });
  }

  function stopCamera() {
    if (scanRAF) { cancelAnimationFrame(scanRAF); scanRAF = null; }
    if (mediaStream) {
      mediaStream.getTracks().forEach(function(t) { t.stop(); });
      mediaStream = null;
    }
    if (videoEl) { videoEl.remove(); videoEl = null; }
    cameraRunning = false;
    isDecoding = false;
    torchOn = false;
    torchTrack = null;
    hideTorchButton();
    dom.placeholder.classList.remove('d-none');
    dom.crosshair.classList.add('d-none');
    dom.btnToggle.innerHTML = '<i class="bi bi-play-fill"></i> Start';
    dom.btnToggle.classList.replace('btn-danger', 'btn-light');
  }

  // -----------------------------------------------------------------------
  // Torch (flashlight) for mobile
  // -----------------------------------------------------------------------
  var btnTorch = null;

  function showTorchButton() {
    if (btnTorch) return;
    btnTorch = document.createElement('button');
    btnTorch.className = 'btn btn-sm btn-outline-warning';
    btnTorch.id = 'btnTorch';
    btnTorch.innerHTML = '<i class="bi bi-lightbulb"></i>';
    btnTorch.title = 'Flashlight';
    btnTorch.addEventListener('click', toggleTorch);
    dom.btnToggle.parentNode.insertBefore(btnTorch, dom.btnToggle);
  }

  function hideTorchButton() {
    if (btnTorch) { btnTorch.remove(); btnTorch = null; }
  }

  function toggleTorch() {
    if (!torchTrack) return;
    torchOn = !torchOn;
    torchTrack.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(function() {});
    if (btnTorch) {
      btnTorch.className = torchOn ? 'btn btn-sm btn-warning' : 'btn btn-sm btn-outline-warning';
    }
  }

  // -----------------------------------------------------------------------
  // Scan loop (requestAnimationFrame-based)
  // -----------------------------------------------------------------------
  function scanLoop(timestamp) {
    if (!cameraRunning) return;
    scanRAF = requestAnimationFrame(scanLoop);

    if (isDecoding) return;
    if (timestamp - lastScanTime < SCAN_INTERVAL_MS) return;
    if (!videoEl || videoEl.readyState < 2) return;

    lastScanTime = timestamp;
    isDecoding = true;

    detectQuagga();
  }

  // -----------------------------------------------------------------------
  // Center-crop frame to processing canvas + auto-contrast
  // -----------------------------------------------------------------------
  function cropFrameToCanvas() {
    var vw = videoEl.videoWidth;
    var vh = videoEl.videoHeight;
    var cropW = Math.round(vw * CROP_RATIO);
    var cropH = Math.round(vh * CROP_HEIGHT_RATIO);
    var cropX = Math.round((vw - cropW) / 2);
    var cropY = Math.round((vh - cropH) / 2);
    procCtx.drawImage(videoEl, cropX, cropY, cropW, cropH, 0, 0, PROC_W, PROC_H);
  }

  /**
   * Enhance contrast of the processing canvas in-place.
   * Converts to grayscale and stretches histogram — helps in poor lighting
   * or washed-out images common on mobile cameras.
   */
  function enhanceContrast() {
    var imgData = procCtx.getImageData(0, 0, PROC_W, PROC_H);
    var d = imgData.data;
    var len = d.length;
    // Find min/max luminance (sample every 4th pixel for speed)
    var lo = 255, hi = 0;
    for (var i = 0; i < len; i += 16) {
      var gray = (d[i] * 77 + d[i+1] * 150 + d[i+2] * 29) >> 8;
      if (gray < lo) lo = gray;
      if (gray > hi) hi = gray;
    }
    var range = hi - lo;
    if (range < 30) return imgData; // already very low contrast, skip (probably blank)
    if (range > 220) return imgData; // already good contrast
    // Stretch histogram
    var scale = 255 / range;
    for (var j = 0; j < len; j += 4) {
      d[j]   = Math.min(255, Math.max(0, ((d[j]   - lo) * scale) | 0));
      d[j+1] = Math.min(255, Math.max(0, ((d[j+1] - lo) * scale) | 0));
      d[j+2] = Math.min(255, Math.max(0, ((d[j+2] - lo) * scale) | 0));
    }
    procCtx.putImageData(imgData, 0, 0);
    return imgData;
  }

  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // Quagga2 detection (center-cropped, contrast-enhanced)
  //
  // Multi-pass: tries locate first, falls back to no-locate with
  // multiple patch sizes for difficult/blurry barcodes.
  // -----------------------------------------------------------------------
  var quaggaPass = 0; // cycles through configs each frame

  var QUAGGA_CONFIGS = [
    // Pass 0: standard locate with medium patch
    { locate: true, locator: { patchSize: 'medium', halfSample: true } },
    // Pass 1: large patch — better for far/small barcodes
    { locate: true, locator: { patchSize: 'large', halfSample: true } },
    // Pass 2: small patch — better for close-up/large barcodes
    { locate: true, locator: { patchSize: 'small', halfSample: false } },
    // Pass 3: no locate, scan entire frame — catches barcodes locator misses
    { locate: false, locator: { patchSize: 'medium', halfSample: true } },
  ];

  function detectQuagga() {
    cropFrameToCanvas();
    enhanceContrast();
    var dataUrl = procCanvas.toDataURL('image/jpeg', 0.85);

    var cfg = QUAGGA_CONFIGS[quaggaPass % QUAGGA_CONFIGS.length];
    quaggaPass++;

    Quagga.decodeSingle({
      src: dataUrl,
      numOfWorkers: 0,
      decoder: {
        readers: QUAGGA_READERS,
        multiple: false
      },
      locate: cfg.locate,
      locator: cfg.locator
    }, function(result) {
      isDecoding = false;
      if (result && result.codeResult && result.codeResult.code) {
        onBarcodeDetected(result.codeResult.code);
      }
    });
  }

  // -----------------------------------------------------------------------
  // Barcode confirmation (anti-shake / anti-false-positive)
  // -----------------------------------------------------------------------
  function onBarcodeDetected(code) {
    var now = Date.now();
    if (now - lastDetectedTime < COOLDOWN_MS) return;
    if (!code) return;

    if (code === pendingCode) {
      pendingCount++;
    } else {
      pendingCode = code;
      pendingCount = 1;
    }
    if (pendingCount < CONFIRM_COUNT) return;

    // Confirmed
    lastDetectedTime = now;
    pendingCode = null;
    pendingCount = 0;

    if (navigator.vibrate) navigator.vibrate(100);

    // Audio beep feedback
    try {
      var actx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = actx.createOscillator();
      var gain = actx.createGain();
      osc.connect(gain);
      gain.connect(actx.destination);
      osc.frequency.value = 1200;
      gain.gain.value = 0.15;
      osc.start();
      osc.stop(actx.currentTime + 0.1);
    } catch (e) {}

    dom.searchInput.value = code;
    lookupBarcode(code);
  }

  // -----------------------------------------------------------------------
  // Barcode lookup
  // -----------------------------------------------------------------------
  function lookupBarcode(code) {
    showBarcodeAlert(code);
    hideResults();

    fetch('/api/stock/search?q=' + encodeURIComponent(code) + '&limit=1')
      .then(function(res) { return res.json(); })
      .then(function(data) {
        hideBarcodeAlert();
        if (data.length > 0) {
          displayStockDetail(data[0]);
        } else {
          showNoResult();
        }
      })
      .catch(function(e) {
        hideBarcodeAlert();
        console.error('Lookup failed:', e);
        showNoResult();
      });
  }

  // -----------------------------------------------------------------------
  // Camera controls
  // -----------------------------------------------------------------------
  dom.btnToggle.addEventListener('click', function() {
    if (cameraRunning) { stopCamera(); } else { startCamera(); }
  });

  dom.cameraSelect.addEventListener('change', function() {
    if (cameraRunning) { stopCamera(); startCamera(); }
  });

  // -----------------------------------------------------------------------
  // Text search (debounced)
  // -----------------------------------------------------------------------
  var searchTimer = null;

  dom.searchInput.addEventListener('input', function() {
    var q = this.value.trim();
    clearTimeout(searchTimer);
    if (!q) {
      dom.searchDropdown.classList.add('d-none');
      return;
    }
    searchTimer = setTimeout(function() { textSearch(q); }, 300);
  });

  dom.searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchTimer);
      var q = this.value.trim();
      if (q) textSearch(q);
    }
  });

  document.addEventListener('click', function(e) {
    if (!dom.searchDropdown.contains(e.target) && e.target !== dom.searchInput) {
      dom.searchDropdown.classList.add('d-none');
    }
  });

  function textSearch(query) {
    fetch('/api/stock/search?q=' + encodeURIComponent(query) + '&limit=10')
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data.length) {
          dom.searchDropdown.classList.add('d-none');
          return;
        }
        dom.searchDropdown.innerHTML = data.map(function(item, i) {
          return '<button type="button" class="list-group-item list-group-item-action" data-idx="' + i + '">'
            + '<div class="d-flex justify-content-between align-items-start">'
            + '<div>'
            + '<div class="fw-semibold" style="font-size:var(--fs-base)">' + esc(item.artname) + '</div>'
            + '<small class="text-muted" style="font-family:monospace">' + esc(item.artno) + '</small>'
            + '</div>'
            + '<span class="badge ' + (item.score >= 85 ? 'bg-primary' : item.score >= 60 ? 'bg-warning text-dark' : 'bg-secondary') + '"'
            + ' style="font-size:var(--fs-2xs)">' + item.score + (item.match_type === 'barcode' ? ' BC' : item.match_type === 'alias' ? ' AL' : '') + '</span>'
            + '</div>'
            + '</button>';
        }).join('');
        dom.searchDropdown._data = data;
        dom.searchDropdown.classList.remove('d-none');
      })
      .catch(function(e) {
        console.error('Search failed:', e);
      });
  }

  dom.searchDropdown.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-idx]');
    if (!btn) return;
    var idx = parseInt(btn.dataset.idx);
    var data = dom.searchDropdown._data;
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

    // Harga Beli (permission-gated)
    if (SHOW_BELI) {
      dom.sdHbeliBsr.textContent = fmt(item.hbelibsr);
      dom.sdHbeliKcl.textContent = fmt(item.hbelikcl);
      dom.sdDisc1.textContent = fmtPct(item.pctdisc1);
      dom.sdDisc2.textContent = fmtPct(item.pctdisc2);
      dom.sdDisc3.textContent = fmtPct(item.pctdisc3);
      dom.sdPPN.textContent = fmtPct(item.pctppn);

      var netto = item.hbelikcl || 0;
      if (item.pctdisc1) netto *= (1 - item.pctdisc1 / 100);
      if (item.pctdisc2) netto *= (1 - item.pctdisc2 / 100);
      if (item.pctdisc3) netto *= (1 - item.pctdisc3 / 100);
      if (item.pctppn) netto *= (1 + item.pctppn / 100);
      dom.sdNetto.textContent = fmt(Math.round(netto));
    }

    // Harga Jual (permission-gated)
    if (SHOW_JUAL) {
      var netto2 = item.hbelikcl || 0;
      if (item.pctdisc1) netto2 *= (1 - item.pctdisc1 / 100);
      if (item.pctdisc2) netto2 *= (1 - item.pctdisc2 / 100);
      if (item.pctdisc3) netto2 *= (1 - item.pctdisc3 / 100);
      if (item.pctppn) netto2 *= (1 + item.pctppn / 100);

      var tiers = [
        { label: 'H.Jual 1', val: item.hjual },
        { label: 'Member', val: item.hjual2 },
        { label: 'H.Jual 3', val: item.hjual3 },
        { label: 'H.Jual 4', val: item.hjual4 },
        { label: 'H.Jual 5', val: item.hjual5 },
      ];
      dom.sdJualBody.innerHTML = tiers.map(function(t) {
        if (SHOW_MARGIN) {
          var hasMargin = t.val > 0 && netto2 > 0;
          var margin = hasMargin ? (((t.val - netto2) / netto2) * 100).toFixed(2) + '%' : '-';
          var marginClass = (hasMargin && t.val < netto2) ? 'text-danger' : '';
          return '<tr><td>' + t.label + '</td><td class="text-end">' + fmt(t.val) + '</td><td class="text-end ' + marginClass + '">' + margin + '</td></tr>';
        }
        return '<tr><td>' + t.label + '</td><td class="text-end">' + fmt(t.val) + '</td></tr>';
      }).join('');

      var bundlings = item._bundlings || [];
      if (bundlings.length > 0) {
        dom.sdBundlingSection.classList.remove('d-none');
        dom.sdBundlingBody.innerHTML = bundlings.map(function(b) {
          return '<tr><td>' + b.qty + '</td><td class="text-end">' + fmt(b.hjual1) + '</td><td class="text-end">' + fmt(b.hjual2) + '</td><td class="text-end">' + fmt(b.hjual3) + '</td><td class="text-end">' + fmt(b.hjual4) + '</td><td class="text-end">' + fmt(b.hjual5) + '</td></tr>';
        }).join('');
      } else {
        dom.sdBundlingSection.classList.add('d-none');
      }
    }

    dom.stockDetail.classList.remove('d-none');
    fetchBalance(item.artno, item.satkecil);
  }

  function fetchBalance(artno, satkecil) {
    dom.sdStockLoading.classList.remove('d-none');
    dom.sdStockBalances.innerHTML = '';

    fetch('/api/stock/balance/' + encodeURIComponent(artno))
      .then(function(res) { return res.json(); })
      .then(function(rows) {
        dom.sdStockLoading.classList.add('d-none');
        if (rows.length === 0) {
          dom.sdStockBalances.innerHTML = '<div class="text-muted" style="font-size:var(--fs-sm)">Tidak ada data stok</div>';
          return;
        }
        dom.sdStockBalances.innerHTML = rows.map(function(r) {
          return '<div class="sd-balance-row">'
            + '<span class="sd-balance-wh">' + esc(r.warehouseid || 'DEFAULT') + '</span>'
            + '<span class="sd-balance-qty">' + fmtQty(r.curqty) + ' <small class="sd-balance-unit">' + esc(satkecil || '') + '</small></span>'
            + '</div>';
        }).join('');
      })
      .catch(function() {
        dom.sdStockLoading.classList.add('d-none');
        dom.sdStockBalances.innerHTML = '<div class="text-danger" style="font-size:var(--fs-sm)">Gagal memuat stok</div>';
      });
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
    if (dom.sdBundlingSection) dom.sdBundlingSection.classList.add('d-none');
  }

  function showNoResult() {
    dom.noResultCard.classList.remove('d-none');
    dom.stockDetail.classList.add('d-none');
  }

})();
