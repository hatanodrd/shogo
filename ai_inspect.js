// =========================================================
// ai_inspect.js : MobileNet v2 パン屋AI照合・1Dバーコード強化・ステップ検査
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
  badge.textContent = 'AIモデル(MobileNet v2)読込中...';
  badge.style.color = '#ffeb3b';

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
    badge.textContent = '🥐 パン屋AI (MobileNet v2) 準備完了';
    badge.style.color = '#00e676';
  } catch (e) {
    badge.textContent = '🥐 パン屋AI (高速特徴モード) 準備完了';
    badge.style.color = '#00e676';
  }
}

function getScaledStepCoords(step, targetW, targetH) {
  if (!step || step.isFullFrame) {
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
// 🎯 1次元バーコード＆QR 高精度検出エンジン
// （マルチフレーム連続リトライ ＋ 上下スライス ＋ コントラスト強調）
// =========================================================
function getFallbackScanner() {
  if (!fallbackHtml5Scanner) {
    fallbackHtml5Scanner = new Html5Qrcode('hiddenReaderFallback');
  }
  return fallbackHtml5Scanner;
}

// キャンバス領域に白余白を付け、必要に応じてコントラストを強調した画像を生成
function buildBarcodeCandidateCanvas(srcSource, sx, sy, sw, sh, enhanceContrast = false) {
  const pad = 24; // 1次元バーコード認識に必須の左右白余白（クワイエットゾーン）
  const targetW = Math.min(960, Math.max(320, sw));
  const scale = targetW / Math.max(1, sw);
  const targetH = Math.max(80, Math.round(sh * scale));

  reusableCropCanvas.width = targetW + pad * 2;
  reusableCropCanvas.height = targetH + pad * 2;

  reusableCropCtx.fillStyle = '#ffffff';
  reusableCropCtx.fillRect(0, 0, reusableCropCanvas.width, reusableCropCanvas.height);
  reusableCropCtx.drawImage(srcSource, sx, sy, sw, sh, pad, pad, targetW, targetH);

  if (enhanceContrast) {
    const imgData = reusableCropCtx.getImageData(0, 0, reusableCropCanvas.width, reusableCropCanvas.height);
    const d = imgData.data;
    // 輝度計算と強めのコントラストストレッチ
    let minG = 255, maxG = 0;
    for (let i = 0; i < d.length; i += 16) {
      const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      if (g < minG) minG = g;
      if (g > maxG) maxG = g;
    }
    const range = Math.max(40, maxG - minG);
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      let norm = ((g - minG) / range) * 255;
      // S字カーブ強調で白と黒の境界をくっきりさせる
      norm = norm < 128 ? Math.max(0, norm * 0.75) : Math.min(255, 128 + (norm - 128) * 1.25);
      d[i] = d[i + 1] = d[i + 2] = norm;
    }
    reusableCropCtx.putImageData(imgData, 0, 0);
  }
  return reusableCropCanvas;
}

async function tryDecodeSingleCanvas(canvasEl) {
  // 1. ネイティブ BarcodeDetector (対応環境)
  if (sharedBarcodeDetector) {
    try {
      const results = await sharedBarcodeDetector.detect(canvasEl);
      if (results && results.length > 0) {
        const fmt = (results[0].format || '').toLowerCase();
        return { value: results[0].rawValue, isQr: fmt === 'qr_code' };
      }
    } catch (e) {}
  }

  // 2. iOS / 非対応ブラウザ用 Html5Qrcode (ZXing) 静止画デコード
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

// 1回の検査ボタン押下で最大7フレーム（約1.5秒）連続スキャン＆マルチスライス解析
async function detectBarcodeFromCanvas(sourceCanvas, step) {
  const maxAttempts = 7;
  const videoEl = document.getElementById('videoSource');

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 2回目以降は最新カメラフレームが更新されるのを少し待つ
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 180));
      if (videoEl && isCamRunning && videoEl.readyState >= 2) {
        const ctx = sourceCanvas.getContext('2d');
        ctx.drawImage(videoEl, 0, 0, sourceCanvas.width, sourceCanvas.height);
      }
    }

    const coords = getScaledStepCoords(step, sourceCanvas.width, sourceCanvas.height);
    const rx = coords.x, ry = coords.y;
    const rw = Math.max(32, coords.w), rh = Math.max(32, coords.h);

    // 候補パターン：
    // ① 枠全体（通常＋白余白）
    // ② 枠全体（コントラスト強調＋白余白）
    // ③ 枠の中央帯（1Dバーコード水平走査集中）
    // ④ 枠の上部帯・下部帯（バーコードが上下にズレている場合の救済）
    const slices = [
      { y: ry, h: rh, enhance: false },
      { y: ry, h: rh, enhance: true },
      { y: ry + Math.round(rh * 0.25), h: Math.round(rh * 0.5), enhance: true },
      { y: ry + Math.round(rh * 0.1),  h: Math.round(rh * 0.45), enhance: true },
      { y: ry + Math.round(rh * 0.45), h: Math.round(rh * 0.45), enhance: true }
    ];

    for (let i = 0; i < slices.length; i++) {
      const sl = slices[i];
      if (sl.h < 24) continue;
      const candCanvas = buildBarcodeCandidateCanvas(sourceCanvas, rx, sl.y, rw, sl.h, sl.enhance);
      const res = await tryDecodeSingleCanvas(candCanvas);
      if (res && res.value) {
        return res;
      }
    }
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
    return `<span class="step-chip ${cls}">${idx + 1}. ${ic} ${s.name}</span>`;
  }).join('');

  const banner = document.getElementById('stepInstructionBanner');
  const bcBox = document.getElementById('workerBarcodeInputBox');
  const btnExec = document.getElementById('btnExecuteStep');

  if (step.type === 'BARCODE') {
    banner.textContent = `👉 Step ${window.currentStepIdx + 1} / ${window.currentSteps.length} ：【 ${step.name} 】のコードを読み取ってください`;
    bcBox.style.display = 'block';
    btnExec.textContent = `🔍 カメラで【 ${step.name} 】のコードを読取・照合 (Space)`;
    if (announceVoice) speakText(`${step.name}のコードを読み取ってください`);
  } else {
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
  const origBtnText = btnExec.textContent;
  isInspectingStep = true;

  try {
    if (step.type === 'BARCODE') {
      btnExec.textContent = '⏳ バーコード読取中... (そのままかざしてください)';
      btnExec.disabled = true;

      const codeObj = await detectBarcodeFromCanvas(mainCanvas, step);
      if (!codeObj) {
        alert('枠内からバーコード/QRを検出できませんでした。\nバーコードを水平に向け、光の反射を避けてもう一度お試しください。');
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
