// =========================================================
// ai_inspect.js : パン屋AI(中心化ブレンド類似度＋安全マージン比較)・バーコード・OCR検査
// =========================================================
window.currentInspectPart = '';
window.currentSteps = [];
window.currentStepIdx = 0;
let isInspectingStep = false;
window.isChatteringCooldown = false;
let cooldownInterval = null;
let fallbackHtml5Scanner = null;
let aiModelInitPromise = null;

// 半透明シルエット画像のメモリキャッシュ（DataURL -> Imageオブジェクト）
const ghostImageObjCache = {};

async function initAI() {
  if (aiModelInitPromise) return aiModelInitPromise;
  aiModelInitPromise = (async () => {
    const badge = document.getElementById('aiLiveBadge');
    if (badge) {
      badge.textContent = 'AI・バーコード・OCRエンジン読込中...';
      badge.style.color = '#ffeb3b';
    }

    loadQuaggaScript();

    let retry = 0;
    while ((typeof tf === 'undefined' || typeof mobilenet === 'undefined') && retry < 20) {
      await new Promise(r => setTimeout(r, 500));
      retry++;
    }
    if (typeof tf === 'undefined' || typeof mobilenet === 'undefined') {
      if (badge) {
        badge.textContent = 'AIオフライン (色・形状特徴フォールバック動作)';
        badge.style.color = '#ff9800';
      }
      return;
    }
    try {
      await tf.ready();
      mobilenetModel = await mobilenet.load({ version: 2, alpha: 1.0 });
      if (badge) {
        badge.textContent = '🥐 パン屋AI(👻シルエット対応) ＆ 🎯コード/OCR 準備完了';
        badge.style.color = '#00e676';
      }
    } catch (e) {
      if (badge) {
        badge.textContent = '🥐 パン屋AI (高速特徴モード) 準備完了';
        badge.style.color = '#00e676';
      }
    }
  })();
  return aiModelInitPromise;
}

function loadQuaggaScript() {
  if (typeof Quagga !== 'undefined') return;
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.8.4/dist/quagga.min.js';
  s.async = true;
  document.head.appendChild(s);
}

// =========================================================
// 👻 半透明シルエット（ゴーストガイド）画像の生成 ＆ 描画ヘルパー
// =========================================================
function captureGhostImageDataUrl(sourceCanvas) {
  const videoEl = document.getElementById('videoSource');
  const src = (videoEl && isCamRunning && videoEl.readyState >= 2) ? videoEl : sourceCanvas;
  const gCanvas = document.createElement('canvas');
  gCanvas.width = 320;
  gCanvas.height = 240;
  const gCtx = gCanvas.getContext('2d');
  gCtx.drawImage(src, 0, 0, gCanvas.width, gCanvas.height);
  return gCanvas.toDataURL('image/jpeg', 0.72);
}

function resolveStepGhostDataUrl(step) {
  if (!step || step.type !== 'BAKERY') return null;
  if (step.ghostImage) return step.ghostImage;
  if (step.materialCode && window.materialMastersCache) {
    const materials = window.materialMastersCache;
    const matKey = (typeof findMatchingMasterPart === 'function')
      ? findMatchingMasterPart(step.materialCode, materials)
      : (materials[step.materialCode] ? step.materialCode : null);
    if (matKey && materials[matKey] && materials[matKey].ghostImage) {
      return materials[matKey].ghostImage;
    }
  }
  return null;
}

function getCachedGhostImageElement(dataUrl) {
  if (!dataUrl) return null;
  if (!ghostImageObjCache[dataUrl]) {
    const img = new Image();
    img.src = dataUrl;
    ghostImageObjCache[dataUrl] = img;
  }
  return ghostImageObjCache[dataUrl];
}

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
  if (step && step.type === 'OCR') {
    const wPct = (typeof ocrDefaultConfig !== 'undefined' && ocrDefaultConfig.width) ? ocrDefaultConfig.width : 75;
    const hPct = (typeof ocrDefaultConfig !== 'undefined' && ocrDefaultConfig.height) ? ocrDefaultConfig.height : 14;
    const w = Math.round(targetW * (wPct / 100));
    const h = Math.round(targetH * (hPct / 100));
    return {
      x: Math.round((targetW - w) / 2),
      y: Math.round((targetH - h) / 2),
      w: w,
      h: h
    };
  }
  return { x: 0, y: 0, w: targetW, h: targetH };
}

function drawSmartRoiOverlay(ctx, canvasW, canvasH, step, labelPrefix) {
  if (!step) return;
  const coords = getScaledStepCoords(step, canvasW, canvasH);
  const isBarcode = step.type === 'BARCODE';
  const isOcr = step.type === 'OCR';
  const isBakery = step.type === 'BAKERY';
  const color = isBarcode ? '#00e676' : (isOcr ? '#00e5ff' : '#ab47bc');

  let isGhostDrawn = false;
  if (isBakery && typeof ghostGuideConfig !== 'undefined' && ghostGuideConfig.enabled) {
    const ghostUrl = resolveStepGhostDataUrl(step);
    const ghostImg = getCachedGhostImageElement(ghostUrl);
    if (ghostImg && ghostImg.complete && ghostImg.naturalWidth > 0) {
      ctx.save();
      ctx.globalAlpha = Math.max(0.1, Math.min(0.75, (ghostGuideConfig.opacity || 35) / 100));
      ctx.drawImage(ghostImg, 0, 0, canvasW, canvasH);
      ctx.restore();
      isGhostDrawn = true;
    }
  }

  if (isBarcode || isOcr) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.48)';
    ctx.fillRect(0, 0, canvasW, coords.y);
    ctx.fillRect(0, coords.y + coords.h, canvasW, canvasH - (coords.y + coords.h));
    ctx.fillRect(0, coords.y, coords.x, coords.h);
    ctx.fillRect(coords.x + coords.w, coords.y, canvasW - (coords.x + coords.w), coords.h);

    if (isBarcode) {
      const midY = coords.y + Math.round(coords.h / 2);
      ctx.strokeStyle = 'rgba(255, 23, 68, 0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(coords.x + 10, midY);
      ctx.lineTo(coords.x + coords.w - 10, midY);
      ctx.stroke();
    }
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  ctx.strokeRect(coords.x + 2, coords.y + 2, coords.w - 4, coords.h - 4);

  let modeDesc = isGhostDrawn
    ? `👻シルエット(${ghostGuideConfig.opacity}%)に合わせて撮影`
    : '🥐3連写＋ライバル比較AI';
  if (isBarcode) modeDesc = '📷枠内に収めて検査ボタンを押す';
  else if (isOcr) modeDesc = `🔤文字(OCR)照合 [正解:${step.expectedOcrText || '未設定'}]`;

  const matTag = (!isBarcode && !isOcr && step.materialCode) ? ` [材料:${step.materialCode}]` : '';
  const labelText = `${labelPrefix}${step.name}${matTag} (${modeDesc})`;
  ctx.font = 'bold 15px sans-serif';
  const textWidth = ctx.measureText(labelText).width;
  const boxW = Math.min(canvasW - 12, textWidth + 18);
  const boxH = 26;
  const boxX = (isBarcode || isOcr) ? Math.max(4, Math.min(coords.x, canvasW - boxW - 4)) : 8;
  const boxY = (isBarcode || isOcr) ? ((coords.y - boxH < 4) ? (coords.y + 4) : (coords.y - boxH)) : (canvasH - boxH - 8);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.82)';
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = color;
  ctx.fillText(labelText, boxX + 8, boxY + 18);
}

// AI特徴抽出（読込完了を待機し、生のカメラ映像から抽出）
async function extractBakeryFeatureVector(sourceCanvas) {
  if (!mobilenetModel && aiModelInitPromise) {
    await Promise.race([aiModelInitPromise, new Promise(r => setTimeout(r, 3000))]);
  }

  const videoEl = document.getElementById('videoSource');
  const rawSource = (videoEl && isCamRunning && videoEl.readyState >= 2) ? videoEl : sourceCanvas;
  const srcW = rawSource.videoWidth || rawSource.width || 640;
  const srcH = rawSource.videoHeight || rawSource.height || 480;

  reusableCropCanvas.width = 224;
  reusableCropCanvas.height = 224;
  reusableCropCtx.drawImage(rawSource, 0, 0, srcW, srcH, 0, 0, 224, 224);

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

// ★ 改良版コサイン類似度：素の類似度 + 中心化(平均値減算)類似度のブレンドにより
//    同じ背景上の別部品のスコア水増しを抑え、良品と異品の点差を明確化 ★
function computeCosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  const n = a.length;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;

  let dotRaw = 0, naRaw = 0, nbRaw = 0;
  let dotCent = 0, naCent = 0, nbCent = 0;

  for (let i = 0; i < n; i++) {
    const va = a[i];
    const vb = b[i];
    dotRaw += va * vb;
    naRaw += va * va;
    nbRaw += vb * vb;

    const ca = va - meanA;
    const cb = vb - meanB;
    dotCent += ca * cb;
    naCent += ca * ca;
    nbCent += cb * cb;
  }

  const rawSim = Math.max(0, dotRaw / ((Math.sqrt(naRaw) * Math.sqrt(nbRaw)) || 1));
  const centSim = Math.max(0, dotCent / ((Math.sqrt(naCent) * Math.sqrt(nbCent)) || 1));

  // 素の類似度(50%) + 中心化類似度(50%) のハイブリッドスコア
  return rawSim * 0.5 + centSim * 0.5;
}

// =========================================================
// 🚀 パン屋AI：3連写ブレ吸収 ＋ 安全マージン付きライバル相対比較エンジン
// =========================================================
async function evaluateBakeryWithBurstAndRivals(sourceCanvas, targetSamples, targetThreshold, targetMatKey, allMaterialsMap) {
  const burstCount = 3;
  const burstDelayMs = 140;

  let bestTargetSim = -1;
  let bestFrameFeat = null;
  let hasDimMismatch = false;

  for (let b = 0; b < burstCount; b++) {
    if (b > 0) {
      await new Promise(r => setTimeout(r, burstDelayMs));
    }
    const feat = await extractBakeryFeatureVector(sourceCanvas);
    let frameSim = 0;
    targetSamples.forEach(sample => {
      if (sample && feat && sample.length !== feat.length) {
        hasDimMismatch = true;
      }
      const sim = computeCosineSimilarity(feat, sample) * 100;
      if (sim > frameSim) frameSim = sim;
    });

    if (frameSim > bestTargetSim) {
      bestTargetSim = frameSim;
      bestFrameFeat = feat;
    }
  }

  if (bestTargetSim <= 0 && hasDimMismatch) {
    return {
      passed: false,
      targetScore: 0,
      rivalCode: null,
      rivalScore: null,
      reason: '⚠️ AIエンジンの読込完了前に登録された古い形式のサンプルデータが含まれています。\n材料マスター画面で「🗑️ 良品データを全クリア」のうえ、再度良品を撮影してください。'
    };
  }

  const targetScore = Math.round(bestTargetSim);

  let bestRivalCode = null;
  let bestRivalMemo = '';
  let bestRivalSim = -1;

  if (allMaterialsMap && bestFrameFeat) {
    const matKeys = Object.keys(allMaterialsMap);
    for (let i = 0; i < matKeys.length; i++) {
      const k = matKeys[i];
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

  // ★ 安全マージン（+4%）判定：他材料が一定以上のスコア(65%以上)で、かつ対象材料より4%以上明確に高い場合のみ異品としてブロック ★
  const rivalMinConfidence = Math.max(65, targetThreshold - 10);
  if (rivalScore !== null && rivalScore >= rivalMinConfidence && rivalScore > targetScore + 3) {
    const rivalLabel = bestRivalMemo ? `${bestRivalCode} (${bestRivalMemo})` : bestRivalCode;
    return {
      passed: false,
      targetScore,
      rivalCode: bestRivalCode,
      rivalLabel,
      rivalScore,
      reason: `⚠️ 類似品（異品）の可能性があります！\n・対象材料の一致率: ${targetScore}%\n・他材料 [${rivalLabel}] の一致率: ${rivalScore}% (ライバル品が +${rivalScore - targetScore}% 高スコア)`
    };
  }

  if (targetScore >= targetThreshold) {
    return {
      passed: true,
      targetScore,
      rivalCode: bestRivalCode,
      rivalScore,
      marginDiff,
      detail: rivalScore !== null
        ? `3連写最高:${targetScore}% / 次点[${bestRivalCode}]:${rivalScore}% (差${marginDiff >= 0 ? '+' : ''}${marginDiff}%)`
        : `3連写最高:${targetScore}%`
    };
  }

  const relativeGraceMin = Math.max(50, targetThreshold - 5);
  if (rivalScore !== null && targetScore >= relativeGraceMin && marginDiff >= 4) {
    return {
      passed: true,
      targetScore,
      rivalCode: bestRivalCode,
      rivalScore,
      marginDiff,
      detail: `相対1位合格 (3連写:${targetScore}% / 次点[${bestRivalCode}]:${rivalScore}% 差+${marginDiff}%)`
    };
  }

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
// 🔤 ステップOCR文字照合エンジン
// =========================================================
function isOcrTextMatching(scannedRaw, expectedRaw, matchMode = 'EXACT') {
  const sNorm = normalizeCodeString(scannedRaw);
  const eNorm = normalizeCodeString(expectedRaw);
  if (!sNorm || !eNorm) return false;

  const sUni = (typeof unifyAmbiguousCharsKey === 'function') ? unifyAmbiguousCharsKey(sNorm) : sNorm;
  const eUni = (typeof unifyAmbiguousCharsKey === 'function') ? unifyAmbiguousCharsKey(eNorm) : eNorm;

  if (matchMode === 'CONTAINS') {
    return sNorm.includes(eNorm) || sUni.includes(eUni);
  }
  return sNorm === eNorm || sUni === eUni;
}

async function detectStepOcrFromCanvas(sourceCanvas, step) {
  const videoEl = document.getElementById('videoSource');
  const coords = getScaledStepCoords(step, sourceCanvas.width, sourceCanvas.height);
  const expected = normalizeCodeString(step.expectedOcrText || '');
  const matchMode = step.ocrMatchMode || 'EXACT';

  let lastReadText = '';

  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 200));
    }
    const rawSource = (videoEl && isCamRunning && videoEl.readyState >= 2) ? videoEl : sourceCanvas;
    if (typeof recognizeOcrFromCanvasRect === 'function') {
      const readStr = await recognizeOcrFromCanvasRect(rawSource, coords.x, coords.y, coords.w, coords.h);
      if (readStr) {
        lastReadText = readStr;
        if (expected && isOcrTextMatching(readStr, expected, matchMode)) {
          return { matched: true, text: readStr };
        }
      }
    }
  }
  return { matched: false, text: lastReadText };
}

// =========================================================
// 🎯 バーコード用クロップ ＆ トリプルエンジン
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
  const videoEl = document.getElementById('videoSource');
  const rawSource = (videoEl && isCamRunning && videoEl.readyState >= 2) ? videoEl : sourceCanvas;

  const pad = 28;
  const scale = coords.w < 640 ? (800 / Math.max(1, coords.w)) : 1.0;
  const targetW = Math.round(coords.w * scale);
  const targetH = Math.round(coords.h * scale);

  reusableCropCanvas.width = targetW + pad * 2;
  reusableCropCanvas.height = targetH + pad * 2;

  reusableCropCtx.fillStyle = '#ffffff';
  reusableCropCtx.fillRect(0, 0, reusableCropCanvas.width, reusableCropCanvas.height);
  reusableCropCtx.drawImage(
    rawSource,
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
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 200));
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
    const ic = s.type === 'BAKERY' ? '🥐' : (s.type === 'OCR' ? '🔤' : '📷');
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
  } else if (step.type === 'OCR') {
    banner.textContent = `👉 Step ${window.currentStepIdx + 1} / ${window.currentSteps.length} ：水色の枠に【 ${step.name} 】の文字（${step.expectedOcrText || ''}）を収めて検査ボタンを押してください`;
    bcBox.style.display = 'block';
    btnExec.textContent = `🔤 カメラで【 ${step.name} 】の文字(OCR)を読取・照合 (タップ / Space)`;
    if (announceVoice) speakText(`${step.name}の文字を枠に合わせて検査ボタンを押してください`);
  } else {
    const targetLabel = step.materialCode ? `${step.name}（材料: ${step.materialCode}）` : step.name;
    const ghostNote = (typeof ghostGuideConfig !== 'undefined' && ghostGuideConfig.enabled) ? '半透明シルエットに合わせて' : 'カメラ全体に映して';
    banner.textContent = `👉 Step ${window.currentStepIdx + 1} / ${window.currentSteps.length} ：【 ${targetLabel} 】を${ghostNote}検査ボタンを押してください`;
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
  if (!step) return;
  if (step.type === 'BARCODE') {
    verifyStepBarcodeValue(val, false, step);
  } else if (step.type === 'OCR') {
    verifyStepOcrValue(val, step);
  }
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
    } else if (step.type === 'OCR') {
      const expected = normalizeCodeString(step.expectedOcrText || '');
      if (!expected) {
        alert('このOCRステップには「正解文字列」が設定されていません。設定画面で登録してください。');
        return;
      }
      btnExec.textContent = '🔤 枠内の文字(OCR)を解析中... (そのままキープ)';
      btnExec.disabled = true;

      const ocrRes = await detectStepOcrFromCanvas(mainCanvas, step);
      if (!ocrRes.text) {
        alert('水色の枠内から文字を読み取れませんでした。\n文字が枠の中央にピント良く収まるようにかざして、もう一度検査ボタンを押してください。');
        return;
      }
      verifyStepOcrValue(ocrRes.text, step);
    } else {
      btnExec.textContent = '📸 3連写＆他材料比較中... (そのままキープ)';
      btnExec.disabled = true;

      const materials = (typeof idbGetRaw === 'function' ? await idbGetRaw(MATERIAL_MASTER_KEY) : await idbGet(MATERIAL_MASTER_KEY)) || {};
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

function verifyStepOcrValue(rawReadText, step) {
  const expected = normalizeCodeString(step.expectedOcrText || '');
  const actual = normalizeCodeString(rawReadText || '');
  const matchMode = step.ocrMatchMode || 'EXACT';

  if (!actual) return;

  if (isOcrTextMatching(actual, expected, matchMode)) {
    onCurrentStepPassed(`${step.name} OCR文字一致 (読取:${actual} / 正解:${expected})`);
  } else {
    onCurrentStepFailed(
      `【 ${step.name} 】OCR文字不一致！\n` +
      `・OCR読取文字: ${actual}\n` +
      `・正解文字列 : ${expected} (${matchMode === 'CONTAINS' ? '部分一致' : '完全一致'})`
    );
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
      if (['BARCODE', 'OCR'].includes(window.currentSteps[window.currentStepIdx]?.type)) {
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
