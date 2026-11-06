// =========================================================
// scan_ocr.js : 品番QR読取・影除去＆枠可変OCR（括弧＆O/0同一視対応）
// =========================================================
let partQrScanner = null;
let isPartQrLocked = false;
window.partOcrStream = null;
let partOcrTimer = null;
let isOcrBusy = false;
let tesseractWorker = null;

function submitExternalPartInput() {
  blurActiveInput();
  const inp = document.getElementById('externalPartInput');
  const raw = inp.value;
  inp.value = '';
  if (!raw.trim()) return;
  tryStartInspectionWithPart(normalizeCodeString(raw));
}

function startInspectionFromDropdown() {
  blurActiveInput();
  const val = document.getElementById('selWorkerProfile').value;
  if (!val) return alert('品番を選択してください');
  tryStartInspectionWithPart(val);
}

async function tryStartInspectionWithPart(partNo) {
  blurActiveInput();
  const cleaned = normalizeCodeString(partNo);
  const stored = (await idbGet(STORAGE_KEY)) || {};

  // O(オー)と0(ゼロ)同一視設定を考慮してマスタから正式品番を検索
  const matchedKey = (typeof findMatchingMasterPart === 'function')
    ? findMatchingMasterPart(cleaned, stored)
    : (stored[cleaned] ? cleaned : null);

  if (!matchedKey || !stored[matchedKey] || !stored[matchedKey].stepsData || stored[matchedKey].stepsData.length === 0) {
    playBuzzerPattern('NG');
    speakText('この品番は未登録です。設定画面で登録してください');
    triggerBorderFlash('NG');
    showNgLockScreen(`⚠️ この品番は未登録です: [ ${cleaned} ]\n設定画面で登録してください。`);
    return;
  }

  window.currentInspectPart = matchedKey;
  window.currentSteps = stored[matchedKey].stepsData;
  window.currentStepIdx = 0;
  window.isChatteringCooldown = false;
  playBuzzerPattern('OK');
  await navigateTo('inspectPage');
  updateInspectStepUI(true);
}

async function startPartQrScanner() {
  blurActiveInput();
  await stopPartScanCameras();
  isPartQrLocked = false;
  const box = document.getElementById('scanCamBox');
  const qrEl = document.getElementById('qrReaderPart');
  box.style.display = 'block';
  qrEl.style.display = 'block';
  document.getElementById('btnStopScanCam').style.display = 'inline-flex';

  partQrScanner = new Html5Qrcode('qrReaderPart');
  partQrScanner.start(
    { facingMode: 'environment' },
    { fps: 15, qrbox: { width: 250, height: 150 } },
    (decodedText, decodedResult) => {
      if (isPartQrLocked) return;
      isPartQrLocked = true;
      const fmt = ((decodedResult?.result?.format?.formatName) || '').toUpperCase();
      const isQr = fmt.includes('QR');
      const targetPart = applyQrSubstring(decodedText, isQr);
      stopPartScanCameras().then(() => {
        tryStartInspectionWithPart(targetPart);
      });
    },
    () => {}
  ).catch(err => {
    alert('カメラ起動に失敗しました: ' + err);
    stopPartScanCameras();
  });
}

async function startPartOcrScanner() {
  blurActiveInput();
  await stopPartScanCameras();
  const box = document.getElementById('scanCamBox');
  const vid = document.getElementById('partOcrVideo');
  const guide = document.getElementById('ocrRoiGuide');
  const panel = document.getElementById('ocrSliderPanel');

  box.style.display = 'block';
  vid.style.display = 'block';
  guide.style.display = 'block';
  panel.style.display = 'flex';
  document.getElementById('btnStopScanCam').style.display = 'inline-flex';
  updateOcrRoiStyle();

  try {
    window.partOcrStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false
    });
    vid.srcObject = window.partOcrStream;
    await vid.play();

    if (!tesseractWorker) {
      document.getElementById('ocrRoiBadge').textContent = 'OCRエンジン初期化中...';
      tesseractWorker = await Tesseract.createWorker('eng');
      await tesseractWorker.setParameters({
        // 括弧 ()[] も認識対象に含める
        tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_()[]',
        tessedit_pageseg_mode: '7'
      });
    }
    partOcrTimer = setInterval(() => processOcrFrame(false), 600);
  } catch (e) {
    alert('OCRカメラ起動エラー: ' + e.message);
    stopPartScanCameras();
  }
}

function updateOcrRoiStyle() {
  const wPct = document.getElementById('rngOcrW').value;
  const hPct = document.getElementById('rngOcrH').value;
  document.getElementById('lblOcrW').textContent = wPct;
  document.getElementById('lblOcrH').textContent = hPct;
  const guide = document.getElementById('ocrRoiGuide');
  guide.style.width = wPct + '%';
  guide.style.height = hPct + '%';
}

async function processOcrFrame(forceAccept) {
  if (isOcrBusy || !window.partOcrStream) return;
  const vid = document.getElementById('partOcrVideo');
  const guide = document.getElementById('ocrRoiGuide');
  if (!vid || vid.videoWidth === 0) return;

  isOcrBusy = true;
  try {
    const vRect = vid.getBoundingClientRect();
    const gRect = guide.getBoundingClientRect();
    const vw = vid.videoWidth, vh = vid.videoHeight;

    const scale = Math.max(vRect.width / vw, vRect.height / vh);
    const dispW = vw * scale, dispH = vh * scale;
    const offsetX = (dispW - vRect.width) / 2;
    const offsetY = (dispH - vRect.height) / 2;

    const sx = Math.max(0, Math.round(((gRect.left - vRect.left) + offsetX) / scale));
    const sy = Math.max(0, Math.round(((gRect.top - vRect.top) + offsetY) / scale));
    const sw = Math.min(vw - sx, Math.round(gRect.width / scale));
    const sh = Math.min(vh - sy, Math.round(gRect.height / scale));

    if (sw > 10 && sh > 10) {
      const pad = 12;
      const dbgCanvas = document.getElementById('ocrDebugCanvas');
      dbgCanvas.width = sw + pad * 2;
      dbgCanvas.height = sh + pad * 2;
      const dCtx = dbgCanvas.getContext('2d', { willReadFrequently: true });

      dCtx.fillStyle = '#ffffff';
      dCtx.fillRect(0, 0, dbgCanvas.width, dbgCanvas.height);
      dCtx.drawImage(vid, sx, sy, sw, sh, pad, pad, sw, sh);

      const imgData = dCtx.getImageData(0, 0, dbgCanvas.width, dbgCanvas.height);
      const d = imgData.data;
      const W = dbgCanvas.width, H = dbgCanvas.height;
      const gray = new Uint8Array(W * H);
      const integral = new Int32Array(W * H);

      for (let y = 0; y < H; y++) {
        let rowSum = 0;
        for (let x = 0; x < W; x++) {
          const idx = y * W + x;
          const p = idx * 4;
          const g = Math.round(0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]);
          gray[idx] = g;
          rowSum += g;
          integral[idx] = (y > 0 ? integral[(y - 1) * W + x] : 0) + rowSum;
        }
      }

      const winR = Math.max(8, Math.floor(Math.min(W, H) / 4));
      const shadowBias = parseInt(document.getElementById('rngOcrShadow').value, 10) || 14;

      for (let y = 0; y < H; y++) {
        const y1 = Math.max(0, y - winR), y2 = Math.min(H - 1, y + winR);
        for (let x = 0; x < W; x++) {
          const x1 = Math.max(0, x - winR), x2 = Math.min(W - 1, x + winR);
          const count = (x2 - x1 + 1) * (y2 - y1 + 1);
          const sum = integral[y2 * W + x2]
                    - (y1 > 0 ? integral[(y1 - 1) * W + x2] : 0)
                    - (x1 > 0 ? integral[y2 * W + (x1 - 1)] : 0)
                    + (y1 > 0 && x1 > 0 ? integral[(y1 - 1) * W + (x1 - 1)] : 0);
          const mean = sum / count;
          const idx = y * W + x;
          const isBoundaryPad = (x < pad || x >= W - pad || y < pad || y >= H - pad);
          const bin = (!isBoundaryPad && gray[idx] < (mean - shadowBias)) ? 0 : 255;
          const p = idx * 4;
          d[p] = d[p + 1] = d[p + 2] = bin;
        }
      }
      dCtx.putImageData(imgData, 0, 0);

      if (tesseractWorker) {
        const { data: { text } } = await tesseractWorker.recognize(dbgCanvas);
        const cleaned = normalizeCodeString(text).replace(/[^A-Za-z0-9_\-()\[\]]/g, '');
        if (cleaned.length >= 2) {
          const stored = (await idbGet(STORAGE_KEY)) || {};
          // O(オー)と0(ゼロ)同一視設定を使って登録マスタを検索
          const matchedKey = (typeof findMatchingMasterPart === 'function')
            ? findMatchingMasterPart(cleaned, stored)
            : (stored[cleaned] ? cleaned : null);

          document.getElementById('ocrRoiBadge').textContent = matchedKey
            ? `一致: ${matchedKey}`
            : `読取中: ${cleaned}`;

          if (matchedKey || forceAccept) {
            await stopPartScanCameras();
            await tryStartInspectionWithPart(matchedKey || cleaned);
          }
        }
      }
    }
  } catch (e) {}
  isOcrBusy = false;
}

function recognizeOcrOnceNow() {
  processOcrFrame(true);
}

async function stopPartScanCameras() {
  if (partOcrTimer) {
    clearInterval(partOcrTimer);
    partOcrTimer = null;
  }
  if (window.partOcrStream) {
    window.partOcrStream.getTracks().forEach(t => t.stop());
    window.partOcrStream = null;
  }
  if (partQrScanner) {
    try {
      if (partQrScanner.isScanning) await partQrScanner.stop();
      await partQrScanner.clear();
    } catch (e) {}
    partQrScanner = null;
  }
  document.getElementById('scanCamBox').style.display = 'none';
  document.getElementById('qrReaderPart').style.display = 'none';
  document.getElementById('partOcrVideo').style.display = 'none';
  document.getElementById('ocrRoiGuide').style.display = 'none';
  document.getElementById('ocrSliderPanel').style.display = 'none';
  document.getElementById('btnStopScanCam').style.display = 'none';
  isOcrBusy = false;
}
