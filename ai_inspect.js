// =========================================================
// ai_inspect.js : パン屋AI照合・バーコード専用枠限定＆1D専用エンジン統合版
// =========================================================
window.currentInspectPart = '';
window.currentSteps = [];
window.currentStepIdx = 0;
let isInspectingStep = false;
window.isChatteringCooldown = false;
let cooldownInterval = null;
let fallbackHtml5Scanner = null;
let autoBarcodeTimer = null;
let isAutoBarcodeBusy = false;

async function initAI() {
  const badge = document.getElementById('aiLiveBadge');
  badge.textContent = 'AI・バーコードエンジン読込中...';
  badge.style.color = '#ffeb3b';

  // 1次元バーコード専用エンジン(Quagga2)を動的ロード
  loadQuaggaScript();

  let retry = 0;
  while ((typeof tf === 'undefined' || typeof mobilenet === 'undefined') && retry < 20) {
    await new Promise(r => setTimeout(r, 500));
    retry++;
  }
  if (typeof tf === 'undefined' || typeof mobilenet === 'undefined') {
    badge.textContent = 'AIオフライン (色・形状特徴フォールバック動作)';
    badge.style.color = '#ff9800';
    return;
  }
  try {
    await tf.ready();
    mobilenetModel = await mobilenet.load({ version: 2, alpha: 1.0 });
    badge.textContent = '🥐 パン屋AI ＆ 🎯高精度バーコード 準備完了';
    badge.style.color = '#00e676';
  } catch (e) {
    badge.textContent = '🥐 パン屋AI (高速特徴モード) 準備完了';
    badge.style.color = '#00e676';
  }
}

function loadQuaggaScript() {
  if (typeof Quagga !== 'undefined') return;
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.8.4/dist/quagga.min.js';
  s.async = true;
  document.head.appendChild(s);
}

// ★ QR・バーコード検査時は、全体枠(isFullFrame)であっても中央の横長枠に自動限定する ★
function getScaledStepCoords(step, targetW, targetH) {
  if (!step || step.isFullFrame) {
    if (step && step.type === 'BARCODE') {
      const w = Math.round(targetW * 0.76);
      const h = Math.round(targetH * 0.26);
      return {
        x: Math.round((targetW - w) / 2),
        y: Math.round((targetH - h) / 2),
        w: w,
        h: h
      };
    }
    return { x: 0, y: 0, w: targetW, h: targetH };
  }
  const bw = step.baseW || 640;
  const bh = step.baseH || 480;
  return {
    x: Math.round((step.x || 0) * (targetW / bw)),
    y: Math.round((step.y || 0) * (targetH / bh)),
    w: Math.round((step.w || bw) * (targetW / bw)),
    h: Math.round((step.h || bh) * (targetH / bh))
  };
}

// 画面描画フック：バーコード検査時は枠外を暗くマスクし、中央に赤い水平レーザー線を表示
window.addEventListener('DOMContentLoaded', () => {
  if (typeof window.drawSmartRoiOverlay === 'function') {
    window.drawSmartRoiOverlay = function(ctx, canvasW, canvasH, step, labelPrefix) {
      const coords = getScaledStepCoords(step, canvasW, canvasH);
      const isBarcode = step.type === 'BARCODE';
      const color = isBarcode ? '#00e676' : '#ab47bc';

      // バーコード時は枠外を半透明で暗くして枠内へ視線・ピントを誘導
      if (isBarcode) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.48)';
        ctx.fillRect(0, 0, canvasW, coords.y);
        ctx.fillRect(0, coords.y + coords.h, canvasW, canvasH - (coords.y + coords.h));
        ctx.fillRect(0, coords.y, coords.x, coords.h);
        ctx.fillRect(coords.x + coords.w, coords.y, canvasW - (coords.x + coords.w), coords.h);

        // 中央の水平赤レーザーガイド線
        const midY = coords.y + Math.round(coords.h / 2);
        ctx.strokeStyle = 'rgba(255, 23, 68, 0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(coords.x + 10, midY);
        ctx.lineTo(coords.x + coords.w - 10, midY);
        ctx.stroke();
      }

      // 枠線の描画
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.strokeRect(coords.x, coords.y, coords.w, coords.h);

      const labelText = `${labelPrefix}${step.name} (${isBarcode ? '📷枠内にコードを収めてください' : '🥐パン屋AI'})`;
      ctx.font = 'bold 15px sans-serif';
      const textWidth = ctx.measureText(labelText).width;
      const boxW = Math.min(canvasW - 8, textWidth + 18);
      const boxH = 26;
      const boxX = Math.max(4, Math.min(coords.x, canvasW - boxW - 4));
      const boxY = (coords.y - boxH < 4) ? (coords.y + 4) : (coords.y - boxH);

      ctx.fillStyle = 'rgba(0, 0, 0, 0.82)';
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.fillStyle = color;
      ctx.fillText(labelText, boxX + 8, boxY + 18);
    };
  }
});

async function extractBakeryFeatureVector(sourceCanvas, step) {
  const coords = getScaledStepCoords(step, sourceCanvas.width, sourceCanvas.height);
  reusableCropCanvas.width = 224;
  reusableCropCanvas.height = 224;
  reusableCropCtx.drawImage(
    sourceCanvas,
    coords.x, coords.y, Math.max(16, coords.w), Math.max(16, coords.h),
    0, 0, 224, 224
  );

  if (mobilenetModel && typeof tf !== 'undefined') {
    return tf.tidy(() => {
      const emb = mobilenetModel.infer(reusableCropCanvas, true);
      const raw = emb.dataSync();
      let norm = 0;
      for (let i = 0; i < raw.length; i++) norm += raw[i] * raw[i];
      norm = Math.sqrt(norm) || 1;
      const vec = new Array(raw.length);
      for (let i = 0; i < raw.length; i++) vec[i] = raw[i] / norm;
      return vec;
    });
  }

  const imgData = reusableCropCtx.getImageData(0, 0, 224, 224).data;
  const vec = new Array(48).fill(0);
  for (let i = 0; i < imgData.length; i += 16) {
    vec[(imgData[i] >> 4)]++;
    vec[16 + (imgData[i + 1] >> 4)]++;
    vec[32 + (imgData[i + 2] >> 4)]++;
  }
  const norm = Math.hypot(...vec) || 1;
  return vec.map(v => v / norm);
}

function computeCosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}

// =========================================================
// 🎯 枠限定クロップ ＆ トリプルエンジン（BarcodeDetector + Quagga2 + ZXing）
// =========================================================
function getFallbackScanner() {
  const el = document.getElementById('hiddenReaderFallback');
  if (el && el.style.display === 'none') {
    // iOSでdisplay:noneだと内部Canvasが0pxになり1Dバーコードが潰れる問題を回避
    el.style.display = 'block';
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    el.style.top = '-9999px';
    el.style.width = '640px';
    el.style.height = '480px';
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
  }
  if (!fallbackHtml5Scanner) {
    fallbackHtml5Scanner = new Html5Qrcode('hiddenReaderFallback');
  }
  return fallbackHtml5Scanner;
}

// 枠内領域を拡大・白余白付与して切り抜く
function buildCroppedBarcodeCanvas(sourceCanvas, coords, mode = 'RAW') {
  const pad = 28;
  // 小さいバーコードも線が潰れないよう横幅800px以上に拡大
  const scale = coords.w < 640 ? (800 / Math.max(1, coords.w)) : 1.0;
  const targetW = Math.round(coords.w * scale);
  const targetH = Math.round(coords.h * scale);

  reusableCropCanvas.width = targetW + pad * 2;
  reusableCropCanvas.height = targetH + pad * 2;

  reusableCropCtx.fillStyle = '#ffffff';
  reusableCropCtx.fillRect(0, 0, reusableCropCanvas.width, reusableCropCanvas.height);
  reusableCropCtx.drawImage(
    sourceCanvas,
    coords.x, coords.y, coords.w, coords.h,
    pad, pad, targetW, targetH
  );

  if (mode === 'SHARP_CONTRAST') {
    const imgData = reusableCropCtx.getImageData(0, 0, reusableCropCanvas.width, reusableCropCanvas.height);
    const d = imgData.data;
    let minG = 255, maxG = 0;
    for (let i = 0; i < d.length; i += 16) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (g < minG) minG = g;
      if (g > maxG) maxG = g;
    }
    const mid = (minG + maxG) * 0.5;
    const range = Math.max(30, maxG - minG);
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // 1次元バーコードの白黒エッジを際立たせる強コントラスト化
      let v = ((g - mid) / range) * 360 + 128;
      v = Math.max(0, Math.min(255, v));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    reusableCropCtx.putImageData(imgData, 0, 0);
  }
  return reusableCropCanvas;
}

// Quagga2 による1次元バーコード専用デコード
function decodeWithQuagga(canvasEl) {
  return new Promise((resolve) => {
    if (typeof Quagga === 'undefined') return resolve(null);
    try {
      const dataUrl = canvasEl.toDataURL('image/png');
      Quagga.decodeSingle({
        src: dataUrl,
        numOfWorkers: 0,
        locate: true,
        inputStream: { size: canvasEl.width },
        decoder: {
          readers: [
            'code_128_reader',
            'ean_reader',
            'ean_8_reader',
            'code_39_reader',
            'codabar_reader',
            'i2of5_reader',
            'upc_reader',
            'upc_e_reader'
          ]
        }
      }, (result) => {
        if (result && result.codeResult && result.codeResult.code) {
          resolve({ value: result.codeResult.code, isQr: false });
        } else {
          resolve(null);
        }
      });
    } catch (e) {
      resolve(null);
    }
  });
}

// Html5Qrcode (ZXing) によるQR＆バーコードデコード
function decodeWithHtml5Qrcode(canvasEl) {
  return new Promise((resolve) => {
    canvasEl.toBlob(async (blob) => {
      if (!blob) return resolve(null);
      try {
        const file = new File([blob], 'crop.png', { type: 'image/png' });
        const scanner = getFallbackScanner();
        if (typeof scanner.scanFileV2 === 'function') {
          const res = await scanner.scanFileV2(file, false);
          const fmt = ((res?.result?.format?.formatName) || '').toUpperCase();
          resolve({ value: res.decodedText, isQr: fmt.includes('QR') });
        } else {
          const decodedText = await scanner.scanFile(file, false);
          resolve({ value: decodedText, isQr: false });
        }
      } catch (err) {
        resolve(null);
      }
    }, 'image/png');
  });
}

async function tryDecodeSingleCanvas(canvasEl) {
  // 1. OS標準 BarcodeDetector
  if (sharedBarcodeDetector) {
    try {
      const results = await sharedBarcodeDetector.detect(canvasEl);
      if (results && results.length > 0) {
        const fmt = (results[0].format || '').toLowerCase();
        return { value: results[0].rawValue, isQr: fmt === 'qr_code' };
      }
    } catch (e) {}
  }

  // 2. 1次元バーコードに強い Quagga2 と QRに強い Html5Qrcode を順次実行
  const quaggaRes = await decodeWithQuagga(canvasEl);
  if (quaggaRes && quaggaRes.value) return quaggaRes;

  const zxingRes = await decodeWithHtml5Qrcode(canvasEl);
  if (zxingRes && zxingRes.value) return zxingRes;

  return null;
}

// 1フレーム分の枠内デコード試行（通常画像 ＋ エッジ強調画像の2パス）
async function detectBarcodeSingleFrame(sourceCanvas, step) {
  const coords = getScaledStepCoords(step, sourceCanvas.width, sourceCanvas.height);
  if (coords.w < 20 || coords.h < 20) return null;

  // パス1: 枠内そのまま（白余白付き）
  const rawCanvas = buildCroppedBarcodeCanvas(sourceCanvas, coords, 'RAW');
  let res = await tryDecodeSingleCanvas(rawCanvas);
  if (res && res.value) return res;

  // パス2: コントラスト強調
  const sharpCanvas = buildCroppedBarcodeCanvas(sourceCanvas, coords, 'SHARP_CONTRAST');
  res = await tryDecodeSingleCanvas(sharpCanvas);
  if (res && res.value) return res;

  return null;
}

// ボタン押下時：最大6回（約1.5秒）連続スキャン
async function detectBarcodeFromCanvas(sourceCanvas, step) {
  const videoEl = document.getElementById('videoSource');
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 200));
      if (videoEl && isCamRunning && videoEl.readyState >= 2) {
        sourceCanvas.getContext('2d').drawImage(videoEl, 0, 0, sourceCanvas.width, sourceCanvas.height);
      }
    }
    const res = await detectBarcodeSingleFrame(sourceCanvas, step);
    if (res && res.value) return res;
  }
  return null;
}

// =========================================================
// 🔄 バーコードステップ中の常時オートスキャン（かざすだけで自動読取）
// =========================================================
function startAutoBarcodeLoop() {
  stopAutoBarcodeLoop();
  autoBarcodeTimer = setInterval(async () => {
    if (activePage !== 'inspectPage' || !isCamRunning) return;
    if (isInspectingStep || window.isChatteringCooldown || isAutoBarcodeBusy) return;
    if (document.getElementById('ngOverlay').style.display === 'flex') return;

    const step = window.currentSteps[window.currentStepIdx];
    if (!step || step.type !== 'BARCODE') return;

    isAutoBarcodeBusy = true;
    try {
      const mainCanvas = document.getElementById('mainCanvas');
      const codeObj = await detectBarcodeSingleFrame(mainCanvas, step);
      if (codeObj && codeObj.value && !window.isChatteringCooldown && !isInspectingStep) {
        verifyStepBarcodeValue(codeObj.value, codeObj.isQr, step);
      }
    } catch (e) {}
    isAutoBarcodeBusy = false;
  }, 450);
}

function stopAutoBarcodeLoop() {
  if (autoBarcodeTimer) {
    clearInterval(autoBarcodeTimer);
    autoBarcodeTimer = null;
  }
  isAutoBarcodeBusy = false;
}

function updateInspectStepUI(announceVoice = false) {
  blurActiveInput();
  const step = window.currentSteps[window.currentStepIdx];
  if (!step) return;

  document.getElementById('lblActivePart').textContent = window.currentInspectPart;
  document.getElementById('lblStepProgress').textContent = `Step ${window.currentStepIdx + 1} / ${window.currentSteps.length}`;

  const bar = document.getElementById('stepIndicatorBar');
  bar.innerHTML = window.currentSteps.map((s, idx) => {
    const cls = idx < window.currentStepIdx ? 'done' : (idx === window.currentStepIdx ? 'active' : '');
    const ic = s.type === 'BAKERY' ? '🥐' : '📷';
    return `<span class="step-chip ${cls}">${idx + 1}. ${ic} ${s.name}</span>`;
  }).join('');

  const banner = document.getElementById('stepInstructionBanner');
  const bcBox = document.getElementById('workerBarcodeInputBox');
  const btnExec = document.getElementById('btnExecuteStep');

  if (step.type === 'BARCODE') {
    banner.textContent = `👉 Step ${window.currentStepIdx + 1} / ${window.currentSteps.length} ：緑枠の赤線に【 ${step.name} 】のコードを合わせてください（自動読取）`;
    bcBox.style.display = 'block';
    btnExec.textContent = `🔍 カメラで【 ${step.name} 】のコードを読取・照合 (Space)`;
    if (announceVoice) speakText(`${step.name}のコードを枠内に合わせてください`);
    startAutoBarcodeLoop();
  } else {
    stopAutoBarcodeLoop();
    banner.textContent = `👉 Step ${window.currentStepIdx + 1} / ${window.currentSteps.length} ：【 ${step.name} 】を置いて検査ボタンを押してください`;
    bcBox.style.display = 'none';
    btnExec.textContent = `🥐 【 ${step.name} 】パン屋AI検査を実行 (Space)`;
    if (announceVoice) speakText(`${step.name}を置いて検査ボタンを押してください`);
  }
  drawInspectCanvas();
}

function handleWorkerBarcodeInput() {
  blurActiveInput();
  if (window.isChatteringCooldown || isInspectingStep) return;
  const inp = document.getElementById('workerStepBarcodeInput');
  const val = normalizeCodeString(inp.value);
  inp.value = '';
  if (!val) return;
  const step = window.currentSteps[window.currentStepIdx];
  if (!step || step.type !== 'BARCODE') return;
  verifyStepBarcodeValue(val, false, step);
}

async function executeCurrentStepInspection() {
  blurActiveInput();
  if (isInspectingStep || window.isChatteringCooldown) return;
  const step = window.currentSteps[window.currentStepIdx];
  if (!step) return;

  const mainCanvas = document.getElementById('mainCanvas');
  const btnExec = document.getElementById('btnExecuteStep');
  isInspectingStep = true;

  try {
    if (step.type === 'BARCODE') {
      btnExec.textContent = '⏳ 枠内のバーコードを読取中...';
      btnExec.disabled = true;

      const codeObj = await detectBarcodeFromCanvas(mainCanvas, step);
      if (!codeObj) {
        alert('緑枠内からバーコード/QRを検出できませんでした。\n中央の赤線にバーコードを水平に合わせ、15〜20cm離してかざしてください。');
        return;
      }
      verifyStepBarcodeValue(codeObj.value, codeObj.isQr, step);
    } else {
      if (!step.bakerySamples || step.bakerySamples.length === 0) {
        alert('このステップには良品マスターが登録されていません。設定画面で登録してください。');
        return;
      }
      const feat = await extractBakeryFeatureVector(mainCanvas, step);
      let bestSim = 0;
      step.bakerySamples.forEach(sample => {
        const sim = computeCosineSimilarity(feat, sample) * 100;
        if (sim > bestSim) bestSim = sim;
      });
      const score = Math.round(bestSim);
      const th = step.bakeryThreshold || 80;
      if (score >= th) {
        onCurrentStepPassed(`パン屋AI合格 (${score}%)`);
      } else {
        onCurrentStepFailed(`【 ${step.name} 】パン屋AI照合 NG\n類似度: ${score}% (合格基準: ${th}%以上)`);
      }
    }
  } finally {
    isInspectingStep = false;
    if (!window.isChatteringCooldown) {
      btnExec.disabled = false;
      updateInspectStepUI(false);
    }
  }
}

function verifyStepBarcodeValue(rawScanned, isQr, step) {
  const expected = normalizeCodeString(step.expectedBarcode || '');
  let actual = applyQrSubstring(rawScanned, isQr);
  if (actual !== expected && (qrRangeConfig.start || qrRangeConfig.end)) {
    const subTry = applyQrSubstring(rawScanned, true);
    if (subTry === expected) actual = subTry;
  }

  // 自動スキャン中に背景の無関係な短いノイズ数字を拾った場合の誤発火防止
  if (!actual || actual.length < 2) return;

  if (actual === expected) {
    onCurrentStepPassed(`${step.name}コード一致 (${actual})`);
  } else {
    onCurrentStepFailed(`【 ${step.name} 】コード不一致！\n読取値: ${actual}\n正解値: ${expected}`);
  }
}

function onCurrentStepPassed(detailLog) {
  triggerBorderFlash('OK');
  playBuzzerPattern('OK');

  if (window.currentStepIdx + 1 < window.currentSteps.length) {
    window.currentStepIdx++;
    updateInspectStepUI(true);
    startChatteringCooldown(2.0);
  } else {
    stopAutoBarcodeLoop();
    countOK++;
    updateCounterUI();
    recordInspectionLog(window.currentInspectPart, 'OK', `全${window.currentSteps.length}ステップ合格 (${detailLog})`);
    playBuzzerPattern('COMPLETE');
    speakText('全工程合格です。次の品番を読み取ってください');

    const ov = document.getElementById('completeOverlay');
    ov.style.display = 'flex';
    setTimeout(() => {
      ov.style.display = 'none';
      navigateTo('partScanPage');
    }, 1800);
  }
}

function onCurrentStepFailed(reasonMsg) {
  countNG++;
  updateCounterUI();
  triggerBorderFlash('NG');
  playBuzzerPattern('NG');
  speakText(`検査NG、${window.currentSteps[window.currentStepIdx].name}を確認してください`);
  recordInspectionLog(window.currentInspectPart, 'NG', reasonMsg.replace(/\n/g, ' / '));
  showNgLockScreen(reasonMsg);
}

function startChatteringCooldown(sec) {
  window.isChatteringCooldown = true;
  const btnExec = document.getElementById('btnExecuteStep');
  const btnSub = document.getElementById('btnWorkerBarcodeSubmit');
  const inp = document.getElementById('workerStepBarcodeInput');
  const banner = document.getElementById('stepInstructionBanner');
  const targetMsg = banner.textContent;

  btnExec.disabled = true;
  btnSub.disabled = true;
  inp.disabled = true;
  banner.classList.add('cooldown');

  let rem = sec;
  banner.textContent = `⏳ 前のステップ合格！ 次の箱・ワークへ持ち替えてください (${rem.toFixed(1)}秒待機)`;

  if (cooldownInterval) clearInterval(cooldownInterval);
  cooldownInterval = setInterval(() => {
    rem -= 0.2;
    if (rem <= 0) {
      clearInterval(cooldownInterval);
      cooldownInterval = null;
      window.isChatteringCooldown = false;
      btnExec.disabled = false;
      btnSub.disabled = false;
      inp.disabled = false;
      banner.classList.remove('cooldown');
      banner.textContent = targetMsg;
      if (window.currentSteps[window.currentStepIdx]?.type === 'BARCODE') {
        inp.value = '';
      }
    } else {
      banner.textContent = `⏳ 前のステップ合格！ 次の箱・ワークへ持ち替えてください (${Math.max(0, rem).toFixed(1)}秒待機)`;
    }
  }, 200);
}

function showNgLockScreen(reason) {
  blurActiveInput();
  document.getElementById('ngOverlayReason').textContent = reason;
  document.getElementById('ngOverlay').style.display = 'flex';
}

function unlockNgOverlay() {
  blurActiveInput();
  document.getElementById('ngOverlay').style.display = 'none';
}
