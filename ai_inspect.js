// =========================================================
// ai_inspect.js : パン屋AI（3連写手ブレ吸収＋他材料ライバル相対比較）・バーコード照合
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
    badge.textContent = '🥐 パン屋AI(3連写+相対判定) ＆ 🎯バーコード 準備完了';
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

// AIカメラ検査（BAKERY）は常にカメラ枠全体（100%）に固定
function getScaledStepCoords(step, targetW, targetH) {
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
        ctx.fillRect(coords.x + coords.w, coords.y, canvasW - (coords.x + coords.w), coords.h);

        const midY = coords.y + Math.round(coords.h / 2);
        ctx.strokeStyle = 'rgba(255, 23, 68, 0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(coords.x + 10, midY);
        ctx.lineTo(coords.x + coords.w - 10, midY);
        ctx.stroke();
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = 6;
      ctx.strokeRect(coords.x + 3, coords.y + 3, coords.w - 6, coords.h - 6);

      const matTag = (!isBarcode && step.materialCode) ? ` [材料:${step.materialCode}]` : '';
      const labelText = `${labelPrefix}${step.name}${matTag} (${isBarcode ? '📷枠内に収めて検査ボタンを押す' : '🥐3連写＋ライバル比較AI'})`;
      ctx.font = 'bold 15px sans-serif';
      const textWidth = ctx.measureText(labelText).width;
      const boxW = Math.min(canvasW - 12, textWidth + 18);
      const boxH = 26;
      const boxX = isBarcode ? Math.max(4, Math.min(coords.x, canvasW - boxW - 4)) : 8;
      const boxY = isBarcode ? ((coords.y - boxH < 4) ? (coords.y + 4) : (coords.y - boxH)) : (canvasH - boxH - 8);

      ctx.fillStyle = 'rgba(0, 0, 0, 0.82)';
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.fillStyle = color;
      ctx.fillText(labelText, boxX + 8, boxY + 18);
    };
  }
});

// パン屋AIの特徴抽出：常にキャンバス全体（0, 0, width, height）を対象にする
async function extractBakeryFeatureVector(sourceCanvas) {
  reusableCropCanvas.width = 224;
  reusableCropCanvas.height = 224;
  reusableCropCtx.drawImage(
    sourceCanvas,
    0, 0, sourceCanvas.width, sourceCanvas.height,
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
// 🚀 案3（3連写ブレ吸収）＋ 案1（他材料マスターとの相対比較）統合判定エンジン
// =========================================================
async function evaluateBakeryWithBurstAndRivals(sourceCanvas, targetSamples, targetThreshold, targetMatKey, allMaterialsMap) {
  const burstCount = 3;      // 3連写
  const burstDelayMs = 140;  // 0.14秒間隔（計約0.3秒）
  const videoEl = document.getElementById('videoSource');

  let bestTargetSim = -1;
  let bestFrameFeat = null;

  // 1. 【案3】3連写して手ブレの少ない（正解材料との一致率が最も高い）ベストフレームを選出
  for (let b = 0; b < burstCount; b++) {
    if (b > 0) {
      await new Promise(r => setTimeout(r, burstDelayMs));
      if (videoEl && isCamRunning && videoEl.readyState >= 2) {
        sourceCanvas.getContext('2d').drawImage(videoEl, 0, 0, sourceCanvas.width, sourceCanvas.height);
      }
    }
    const feat = await extractBakeryFeatureVector(sourceCanvas);
    let frameSim = 0;
    targetSamples.forEach(sample => {
      const sim = computeCosineSimilarity(feat, sample) * 100;
      if (sim > frameSim) frameSim = sim;
    });

    if (frameSim > bestTargetSim) {
      bestTargetSim = frameSim;
      bestFrameFeat = feat;
    }
  }

  const targetScore = Math.round(bestTargetSim);

  // 2. 【案1】他の登録済み材料マスター（ライバル品）すべてと同時比較
  let bestRivalCode = null;
  let bestRivalMemo = '';
  let bestRivalSim = -1;

  if (allMaterialsMap && bestFrameFeat) {
    const matKeys = Object.keys(allMaterialsMap);
    for (let i = 0; i < matKeys.length; i++) {
      const k = matKeys[i];
      // 自分自身の材料マスターはスキップ
      if (targetMatKey && normalizeCodeString(k) === normalizeCodeString(targetMatKey)) continue;

      const rivalMat = allMaterialsMap[k];
      if (!rivalMat || !rivalMat.bakerySamples || rivalMat.bakerySamples.length === 0) continue;

      let rSim = 0;
      rivalMat.bakerySamples.forEach(sample => {
        const s = computeCosineSimilarity(bestFrameFeat, sample) * 100;
        if (s > rSim) rSim = s;
      });

      if (rSim > bestRivalSim) {
        bestRivalSim = rSim;
        bestRivalCode = k;
        bestRivalMemo = rivalMat.memo || '';
      }
    }
  }

  const rivalScore = bestRivalCode ? Math.round(bestRivalSim) : null;
  const marginDiff = rivalScore !== null ? (targetScore - rivalScore) : null;

  // 3. 総合合否判定ロジック
  // (A) ライバル品の方がスコアが高い（または同点）場合は、仮に閾値を超えていても「類似異品」として確実にNGにする
  if (rivalScore !== null && rivalScore >= targetScore) {
    const rivalLabel = bestRivalMemo ? `${bestRivalCode} (${bestRivalMemo})` : bestRivalCode;
    return {
      passed: false,
      targetScore,
      rivalCode: bestRivalCode,
      rivalLabel,
      rivalScore,
      reason: `⚠️ 類似品（異品）の可能性があります！\n・対象材料の一致率: ${targetScore}%\n・他材料 [${rivalLabel}] の一致率: ${rivalScore}% (ライバル品の方が高スコア)`
    };
  }

  // (B) 通常の絶対閾値クリア（かつライバル品にも勝っている）
  if (targetScore >= targetThreshold) {
    return {
      passed: true,
      targetScore,
      rivalCode: bestRivalCode,
      rivalScore,
      marginDiff,
      detail: rivalScore !== null
        ? `3連写最高:${targetScore}% / 次点[${bestRivalCode}]:${rivalScore}% (差+${marginDiff}%)`
        : `3連写最高:${targetScore}%`
    };
  }

  // (C) 手持ちブレ救済：絶対閾値より少し低い（-5%以内）が、ライバル品に+3%以上の明確な差をつけて1位の場合に合格救済
  const relativeGraceMin = Math.max(50, targetThreshold - 5);
  if (rivalScore !== null && targetScore >= relativeGraceMin && marginDiff >= 3) {
    return {
      passed: true,
      targetScore,
      rivalCode: bestRivalCode,
      rivalScore,
      marginDiff,
      detail: `相対1位合格 (3連写:${targetScore}% / 次点[${bestRivalCode}]:${rivalScore}% 差+${marginDiff}%)`
    };
  }

  // (D) 閾値未達NG
  const rivalInfoStr = rivalScore !== null
    ? `\n・最も似ている他材料 [${bestRivalCode}]: ${rivalScore}%`
    : '';
  return {
    passed: false,
    targetScore,
    rivalCode: bestRivalCode,
    rivalScore,
    reason: `類似度不足 (3連写最高: ${targetScore}% / 合格基準: ${targetThreshold}%以上)${rivalInfoStr}`
  };
}

// =========================================================
// 🎯 バーコード用クロップ ＆ トリプルエンジン（BarcodeDetector + Quagga2 + ZXing）
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
    banner.textContent = `👉 Step ${window.currentStepIdx + 1} / ${window.currentSteps.length} ：【 ${targetLabel} 】を映して検査ボタンを押してください（3連写＋他材料比較）`;
    bcBox.style.display = 'none';
    btnExec.textContent = `🥐 【 ${targetLabel} 】パン屋AI検査を実行 (3連写・相対判定)`;
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
        alert('緑枠内からバーコード/QRを検出できませんでした。\n中央の赤線にバーコードを水平に合わせ、もう一度検査ボタンを押してください。');
        return;
      }
      verifyStepBarcodeValue(codeObj.value, codeObj.isQr, step);
    } else {
      btnExec.textContent = '📸 3連写＆他材料比較中... (そのままキープ)';
      btnExec.disabled = true;

      const materials = (await idbGet(MATERIAL_MASTER_KEY)) || {};
      window.materialMastersCache = materials;

      let targetSamples = step.bakerySamples || [];
      let targetThreshold = step.bakeryThreshold || 80;
      let matTitle = step.name;
      let resolvedMatKey = null;

      if (step.materialCode) {
        resolvedMatKey = (typeof findMatchingMasterPart === 'function')
          ? findMatchingMasterPart(step.materialCode, materials)
          : (materials[step.materialCode] ? step.materialCode : null);

        if (resolvedMatKey && materials[resolvedMatKey]) {
          const matObj = materials[resolvedMatKey];
          if (matObj.bakerySamples && matObj.bakerySamples.length > 0) {
            targetSamples = matObj.bakerySamples;
          }
          if (!step.bakeryThreshold && matObj.bakeryThreshold) {
            targetThreshold = matObj.bakeryThreshold;
          }
          matTitle = `${step.name} [材料:${resolvedMatKey}]`;
        } else if (!targetSamples || targetSamples.length === 0) {
          alert(`指定された材料マスター [ ${step.materialCode} ] が未登録です。\nホーム画面の「🥐 材料マスター登録」で登録してください。`);
          return;
        }
      }

      if (!targetSamples || targetSamples.length === 0) {
        alert(`このステップ（${matTitle}）には良品マスター画像が1枚も登録されていません。\n材料マスター登録画面で良品を撮影してください。`);
        return;
      }

      // ★ 案3（3連写手ブレ吸収）＋ 案1（ライバル材料比較）で判定 ★
      const evalRes = await evaluateBakeryWithBurstAndRivals(
        mainCanvas,
        targetSamples,
        targetThreshold,
        resolvedMatKey,
        materials
      );

      if (evalRes.passed) {
        onCurrentStepPassed(`${matTitle} パン屋AI合格 (${evalRes.detail})`);
      } else {
        onCurrentStepFailed(`【 ${matTitle} 】パン屋AI照合 NG\n${evalRes.reason}`);
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
