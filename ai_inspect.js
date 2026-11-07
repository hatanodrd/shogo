// =========================================================
// ai_inspect.js : パン屋AI（材料マスター参照対応）・バーコード枠限定照合
// =========================================================
window.currentInspectPart = '';
window.currentSteps = [];
window.currentStepIdx = 0;
let isInspectingStep = false;
window.isChatteringCooldown = false;
let cooldownInterval = null;
let fallbackHtml5Scanner = null;

async function initAI() {
  const badge = document.getElementById('aiLiveBadge');
  badge.textContent = 'AI・バーコードエンジン読込中...';
  badge.style.color = '#ffeb3b';

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

// ステップに材料マスターが紐づいている場合、材料マスター側の枠座標を優先解決する
function resolveStepRoiSource(step) {
  if (!step) return null;
  if (step.type === 'BAKERY' && step.materialCode && window.materialMastersCache && window.materialMastersCache[step.materialCode]) {
    const mat = window.materialMastersCache[step.materialCode];
    if (step.isFullFrame && !mat.isFullFrame) {
      return mat;
    }
  }
  return step;
}

function getScaledStepCoords(step, targetW, targetH) {
  const roiSrc = resolveStepRoiSource(step);
  if (!roiSrc || roiSrc.isFullFrame) {
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
  const bw = roiSrc.baseW || 640;
  const bh = roiSrc.baseH || 480;
  return {
    x: Math.round((roiSrc.x || 0) * (targetW / bw)),
    y: Math.round((roiSrc.y || 0) * (targetH / bh)),
    w: Math.round((roiSrc.w || bw) * (targetW / bw)),
    h: Math.round((roiSrc.h || bh) * (targetH / bh))
  };
}

// 画面描画フック
window.addEventListener('DOMContentLoaded', () => {
  if (typeof window.drawSmartRoiOverlay === 'function') {
    window.drawSmartRoiOverlay = function(ctx, canvasW, canvasH, step, labelPrefix) {
      const coords = getScaledStepCoords(step, canvasW, canvasH);
      const isBarcode = step.type === 'BARCODE';
      const color = isBarcode ? '#00e676' : '#ab47bc';

      if (isBarcode) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.48)';
        ctx.fillRect(0, 0, canvasW, coords.y);
        ctx.fillRect(0, coords.y + coords.h, canvasW, canvasH - (coords.y + coords.h));
        ctx.fillRect(0, coords.y, coords.x, coords.h);
        ctx.fillRect(0, coords.x + coords.w, coords.y, canvasW - (coords.x + coords.w), coords.h);

        const midY = coords.y + Math.round(coords.h / 2);
        ctx.strokeStyle = 'rgba(255, 23, 68, 0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(coords.x + 10, midY);
        ctx.lineTo(coords.x + coords.w - 10, midY);
        ctx.stroke();
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.strokeRect(coords.x, coords.y, coords.w, coords.h);

      const matTag = (!isBarcode && step.materialCode) ? ` [材料:${step.materialCode}]` : '';
      const labelText = `${labelPrefix}${step.name}${matTag} (${isBarcode ? '📷枠内に収めて検査ボタンを押す' : '🥐パン屋AI'})`;
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

function buildCroppedBarcodeCanvas(sourceCanvas, coords, mode = 'RAW') {
  const pad = 28;
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
      let v = ((g - mid) / range) * 360 + 128;
      v = Math.max(0, Math.min(255, v));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    reusableCropCtx.putImageData(imgData, 0, 0);
  }
  return reusableCropCanvas;
}

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
  if (sharedBarcodeDetector) {
    try {
      const results = await sharedBarcodeDetector.detect(canvasEl);
      if (results && results.length > 0) {
        const fmt = (results[0].format || '').toLowerCase();
        return { value: results[0].rawValue, isQr: fmt === 'qr_code' };
      }
    } catch (e) {}
  }

  const quaggaRes = await decodeWithQuagga(canvasEl);
  if (quaggaRes && quaggaRes.value) return quaggaRes;

  const zxingRes = await decodeWithHtml5Qrcode(canvasEl);
  if (zxingRes && zxingRes.value) return zxingRes;

  return null;
}

async function detectBarcodeSingleFrame(sourceCanvas, step) {
  const coords = getScaledStepCoords(step, sourceCanvas.width, sourceCanvas.height);
  if (coords.w < 20 || coords.h < 20) return null;

  const rawCanvas = buildCroppedBarcodeCanvas(sourceCanvas, coords, 'RAW');
  let res = await tryDecodeSingleCanvas(rawCanvas);
  if (res && res.value) return res;

  const sharpCanvas = buildCroppedBarcodeCanvas(sourceCanvas, coords, 'SHARP_CONTRAST');
  res = await tryDecodeSingleCanvas(sharpCanvas);
  if (res && res.value) return res;

  return null;
}

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
    const matInfo = (s.type === 'BAKERY' && s.materialCode) ? `(${s.materialCode})` : '';
    return `<span class="step-chip ${cls}">${idx + 1}. ${ic} ${s.name}${matInfo}</span>`;
  }).join('');

  const banner = document.getElementById('stepInstructionBanner');
  const bcBox = document.getElementById('workerBarcodeInputBox');
  const btnExec = document.getElementById('btnExecuteStep');

  if (step.type === 'BARCODE') {
    banner.textContent = `👉 Step ${window.currentStepIdx + 1} / ${window.currentSteps.length} ：緑枠に【 ${step.name} 】のコードを収めて「検査ボタン」を押してください`;
    bcBox.style.display = 'block';
    btnExec.textContent = `🔍 カメラで【 ${step.name} 】のコードを読取・照合 (タップ / Space)`;
    if (announceVoice) speakText(`${step.name}のコードを枠に合わせて検査ボタンを押してください`);
  } else {
    const targetLabel = step.materialCode ? `${step.name}（材料: ${step.materialCode}）` : step.name;
    banner.textContent = `👉 Step ${window.currentStepIdx + 1} / ${window.currentSteps.length} ：【 ${targetLabel} 】を置いて検査ボタンを押してください`;
    bcBox.style.display = 'none';
    btnExec.textContent = `🥐 【 ${targetLabel} 】パン屋AI検査を実行 (タップ / Space)`;
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

// ★ パン屋AI照合実行：材料マスター(materialCode)が指定されていれば最新の材料マスターから特徴量を自動取得 ★
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
        alert('緑枠内からバーコード/QRを検出できませんでした。\n中央の赤線にバーコードを水平に合わせ、もう一度検査ボタンを押してください。');
        return;
      }
      verifyStepBarcodeValue(codeObj.value, codeObj.isQr, step);
    } else {
      // 材料マスターの解決
      let targetSamples = step.bakerySamples || [];
      let targetThreshold = step.bakeryThreshold || 80;
      let matTitle = step.name;

      if (step.materialCode) {
        const materials = (await idbGet(MATERIAL_MASTER_KEY)) || {};
        window.materialMastersCache = materials;
        const matKey = (typeof findMatchingMasterPart === 'function')
          ? findMatchingMasterPart(step.materialCode, materials)
          : (materials[step.materialCode] ? step.materialCode : null);

        if (matKey && materials[matKey]) {
          const matObj = materials[matKey];
          if (matObj.bakerySamples && matObj.bakerySamples.length > 0) {
            targetSamples = matObj.bakerySamples;
          }
          if (!step.bakeryThreshold && matObj.bakeryThreshold) {
            targetThreshold = matObj.bakeryThreshold;
          }
          matTitle = `${step.name} [材料:${matKey}]`;
        } else if (!targetSamples || targetSamples.length === 0) {
          alert(`指定された材料マスター [ ${step.materialCode} ] が未登録です。\nホーム画面の「🥐 材料マスター登録」で登録してください。`);
          return;
        }
      }

      if (!targetSamples || targetSamples.length === 0) {
        alert(`このステップ（${matTitle}）には良品マスター画像が1枚も登録されていません。\n材料マスター登録画面で良品を撮影してください。`);
        return;
      }

      const feat = await extractBakeryFeatureVector(mainCanvas, step);
      let bestSim = 0;
      targetSamples.forEach(sample => {
        const sim = computeCosineSimilarity(feat, sample) * 100;
        if (sim > bestSim) bestSim = sim;
      });
      const score = Math.round(bestSim);
      if (score >= targetThreshold) {
        onCurrentStepPassed(`${matTitle} パン屋AI合格 (${score}%)`);
      } else {
        onCurrentStepFailed(`【 ${matTitle} 】パン屋AI照合 NG\n類似度: ${score}% (合格基準: ${targetThreshold}%以上)`);
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

  if (!actual) return;

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
