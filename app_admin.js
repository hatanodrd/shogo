// =========================================================
// app_admin.js : 画面遷移・作業者ID必須ガード・品番検索・管理画面編成
// =========================================================
window.adminActivePart = '';
window.adminStepsData = [];
let selectedAdminStepIdx = 0;
let isDraggingRoi = false;
let dragStartX = 0, dragStartY = 0;

let headlessScannerBuffer = '';
let headlessScannerLastTime = 0;

// 設定画面の品番検索キーワード
let adminPartSearchQuery = '';

const video = document.getElementById('videoSource');
const mainCanvas = document.getElementById('mainCanvas');
const mainCtx = mainCanvas.getContext('2d', { willReadFrequently: true });
const adminCanvas = document.getElementById('adminCanvas');
const adminCtx = adminCanvas.getContext('2d', { willReadFrequently: true });

window.addEventListener('DOMContentLoaded', async () => {
  await loadSavedConfigs();
  injectAdminPartSearchUI();
  setupCanvasTouchAndMouse();
  setupKeyboardShortcuts();
  await updateProfileDropdowns();
  await initAI();
});

async function navigateTo(pageId) {
  blurActiveInput();
  headlessScannerBuffer = '';

  // ★ 1. 検査画面（品番読取 / ステップ検査）へ入る際、作業者IDが未登録なら登録モーダルを強制表示 ★
  if ((pageId === 'partScanPage' || pageId === 'inspectPage') && typeof isWorkerRegistered === 'function') {
    if (!isWorkerRegistered()) {
      playBuzzerPattern('NG');
      speakText('先に作業者IDを登録してください');
      await openWorkerQrModal(true, pageId);
      return;
    }
  }

  await stopPartScanCameras();
  if (typeof stopWorkerQrCamera === 'function') {
    await stopWorkerQrCamera();
  }
  stopMainCamera();

  // ★ 2. トップ画面へ戻った場合、作業者IDを「未登録」にリセットする ★
  if (pageId === 'topMenuPage' && typeof clearWorkerRegistration === 'function') {
    clearWorkerRegistration();
  }

  document.querySelectorAll('.page-view').forEach(p => p.classList.remove('active'));
  document.getElementById(pageId).classList.add('active');
  activePage = pageId;

  document.getElementById('btnBackToTop').style.display = (pageId === 'topMenuPage') ? 'none' : 'inline-flex';
  document.getElementById('btnBackToPartScan').style.display = (pageId === 'inspectPage') ? 'inline-flex' : 'none';

  await updateProfileDropdowns();

  if (pageId === 'inspectPage') {
    await startMainCamera();
  } else if (pageId === 'adminPage') {
    drawAdminCanvas();
  }
}

async function startMainCamera() {
  if (isCamRunning) return;
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false
    });
    video.srcObject = camStream;
    await video.play();
    mainCanvas.width = video.videoWidth || 640;
    mainCanvas.height = video.videoHeight || 480;
    adminCanvas.width = mainCanvas.width;
    adminCanvas.height = mainCanvas.height;
    isCamRunning = true;
    document.getElementById('btnAdminCam').textContent = '⏹ カメラ停止';
    requestAnimationFrame(renderLoop);
  } catch (e) {
    console.warn('Camera start failed:', e);
  }
}

function stopMainCamera() {
  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
  }
  video.pause();
  video.srcObject = null;
  isCamRunning = false;
  isTorchOn = false;
  const btnAdminCam = document.getElementById('btnAdminCam');
  if (btnAdminCam) btnAdminCam.textContent = '📷 設定用カメラ起動';
}

async function toggleAdminCamera() {
  blurActiveInput();
  if (isCamRunning) stopMainCamera();
  else await startMainCamera();
}

function renderLoop() {
  if (!isCamRunning) return;
  if (activePage === 'inspectPage') {
    drawInspectCanvas();
  } else if (activePage === 'adminPage') {
    drawAdminCanvas();
  }
  requestAnimationFrame(renderLoop);
}

function drawSmartRoiOverlay(ctx, canvasW, canvasH, step, labelPrefix) {
  const coords = getScaledStepCoords(step, canvasW, canvasH);
  const color = step.type === 'BAKERY' ? '#ab47bc' : '#00e676';
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.strokeRect(coords.x, coords.y, coords.w, coords.h);

  const labelText = `${labelPrefix}${step.name} (${step.type === 'BAKERY' ? '🥐パン屋AI' : '📷コード照合'})`;
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
}

function drawInspectCanvas() {
  mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
  if (isCamRunning && video.readyState >= 2) {
    mainCtx.drawImage(video, 0, 0, mainCanvas.width, mainCanvas.height);
  }
  const step = window.currentSteps[window.currentStepIdx];
  if (step) {
    drawSmartRoiOverlay(mainCtx, mainCanvas.width, mainCanvas.height, step, `Step ${window.currentStepIdx + 1}: `);
  }
}

function drawAdminCanvas() {
  adminCtx.clearRect(0, 0, adminCanvas.width, adminCanvas.height);
  if (isCamRunning && video.readyState >= 2) {
    adminCtx.drawImage(video, 0, 0, adminCanvas.width, adminCanvas.height);
  } else {
    adminCtx.fillStyle = '#263238';
    adminCtx.fillRect(0, 0, adminCanvas.width, adminCanvas.height);
    adminCtx.fillStyle = '#cfd8dc';
    adminCtx.font = 'bold 16px sans-serif';
    adminCtx.fillText('「📷 設定用カメラ起動」を押すと映像が表示されます', 40, adminCanvas.height / 2);
  }
  const step = window.adminStepsData[selectedAdminStepIdx];
  if (step) {
    drawSmartRoiOverlay(adminCtx, adminCanvas.width, adminCanvas.height, step, `編集中 Step ${selectedAdminStepIdx + 1}: `);
  }
}

// =========================================================
// 🔎 管理者用：品番検索（部分一致フィルタ）＆ ステップ編集
// =========================================================
function injectAdminPartSearchUI() {
  const aSel = document.getElementById('selAdminProfile');
  if (!aSel || document.getElementById('adminPartSearchRow')) return;
  const parentRow = aSel.parentElement;
  if (!parentRow) return;

  const searchRow = document.createElement('div');
  searchRow.id = 'adminPartSearchRow';
  searchRow.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:8px; background:#f0f7ff; padding:8px 10px; border-radius:8px; border:1px solid #90caf9;';
  searchRow.innerHTML = `
    <span style="font-size:0.85rem; font-weight:700; color:var(--primary-dark);">🔎 品番検索:</span>
    <input type="text" id="txtAdminPartSearch" placeholder="品番の一部を入力して絞り込み..." style="flex:1; min-width:180px; padding:6px 10px;" autocomplete="off">
    <span id="lblAdminSearchHitCount" style="font-size:0.8rem; font-weight:700; color:var(--primary);">全 0 件</span>
    <button type="button" class="btn" style="padding:5px 10px; font-size:0.78rem;" onclick="clearAdminPartSearch()">クリア</button>
  `;
  parentRow.parentNode.insertBefore(searchRow, parentRow);

  const searchInp = document.getElementById('txtAdminPartSearch');
  searchInp.addEventListener('input', async (e) => {
    adminPartSearchQuery = e.target.value;
    await updateProfileDropdowns(true);
  });
  searchInp.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      blurActiveInput();
      const selVal = document.getElementById('selAdminProfile').value;
      if (selVal) await loadAdminProfile(selVal);
    }
  });
}

async function clearAdminPartSearch() {
  adminPartSearchQuery = '';
  const inp = document.getElementById('txtAdminPartSearch');
  if (inp) inp.value = '';
  await updateProfileDropdowns(false);
}

async function updateProfileDropdowns(fromSearchInput = false) {
  const stored = (await idbGet(STORAGE_KEY)) || {};
  const allKeys = Object.keys(stored).sort();

  document.getElementById('topRegisteredCount').textContent = allKeys.length;
  const cntA = Object.keys(csvTableA).length;
  const cntB = Object.keys(csvTableB).length;
  document.getElementById('topBadgeA').textContent = cntA ? `${cntA}件読込済` : '未読込';
  document.getElementById('topBadgeB').textContent = cntB ? `${cntB}件読込済` : '未読込';

  document.getElementById('cardCsvA').classList.toggle('loaded', cntA > 0);
  document.getElementById('cardCsvB').classList.toggle('loaded', cntB > 0);
  document.getElementById('statusCsvA').textContent = cntA ? `読込済 (${cntA}品番)` : '未読込';
  document.getElementById('statusCsvB').textContent = cntB ? `読込済 (${cntB}品番)` : '未読込';

  // 作業者用プルダウン（全件）
  const wSel = document.getElementById('selWorkerProfile');
  const allOpts = allKeys.map(k => `<option value="${k}">${k} (${(stored[k].stepsData || []).length}ステップ)</option>`).join('');
  wSel.innerHTML = '<option value="">-- 登録済み品番を選択 --</option>' + allOpts;

  // 管理者用プルダウン（検索キーワードで絞り込み対応）
  const aSel = document.getElementById('selAdminProfile');
  const qNorm = normalizeCodeString(adminPartSearchQuery);
  const qUnified = (typeof unifyAmbiguousCharsKey === 'function') ? unifyAmbiguousCharsKey(qNorm) : qNorm;

  const filteredKeys = !qNorm ? allKeys : allKeys.filter(k => {
    const kNorm = normalizeCodeString(k);
    if (kNorm.includes(qNorm)) return true;
    if (typeof unifyAmbiguousCharsKey === 'function') {
      return unifyAmbiguousCharsKey(kNorm).includes(qUnified);
    }
    return false;
  });

  const hitLbl = document.getElementById('lblAdminSearchHitCount');
  if (hitLbl) {
    hitLbl.textContent = qNorm
      ? `該当 ${filteredKeys.length} / ${allKeys.length} 件`
      : `全 ${allKeys.length} 件`;
  }

  const adminOpts = filteredKeys.map(k => `<option value="${k}">${k} (${(stored[k].stepsData || []).length}ステップ)</option>`).join('');
  aSel.innerHTML = `<option value="">-- 編集・確認する品番を選択 (${filteredKeys.length}件) --</option>` + adminOpts;

  if (fromSearchInput && qNorm && filteredKeys.length > 0) {
    // 検索入力時、先頭の候補を自動選択して即座にステップを表示
    const targetPart = filteredKeys.includes(window.adminActivePart) ? window.adminActivePart : filteredKeys[0];
    aSel.value = targetPart;
    window.adminActivePart = targetPart;
    window.adminStepsData = stored[targetPart].stepsData || [];
    selectedAdminStepIdx = 0;
    renderAdminStepsList();
    drawAdminCanvas();
  } else if (window.adminActivePart && stored[window.adminActivePart] && filteredKeys.includes(window.adminActivePart)) {
    aSel.value = window.adminActivePart;
  }
}

async function createOrSwitchAdminProfile() {
  blurActiveInput();
  const name = normalizeCodeString(document.getElementById('txtNewProfileName').value);
  if (!name) return alert('品番名を入力してください');
  const stored = (await idbGet(STORAGE_KEY)) || {};
  if (!stored[name]) {
    stored[name] = {
      stepsData: [{
        name: '外箱',
        type: 'BARCODE',
        fromCsv: false,
        isFullFrame: true,
        x: 0, y: 0, w: 640, h: 480,
        baseW: 640, baseH: 480,
        bakerySamples: [],
        bakeryThreshold: 80,
        expectedBarcode: ''
      }]
    };
    await idbSet(STORAGE_KEY, stored);
  }
  document.getElementById('txtNewProfileName').value = '';
  await clearAdminPartSearch();
  await loadAdminProfile(name);
}

async function loadAdminProfile(partNo) {
  blurActiveInput();
  if (!partNo) return;
  const stored = (await idbGet(STORAGE_KEY)) || {};
  if (!stored[partNo]) return;
  window.adminActivePart = partNo;
  window.adminStepsData = stored[partNo].stepsData || [];
  selectedAdminStepIdx = 0;
  document.getElementById('selAdminProfile').value = partNo;
  renderAdminStepsList();
  drawAdminCanvas();
}

async function autoSaveAdminProfile() {
  if (!window.adminActivePart) return;
  const stored = (await idbGet(STORAGE_KEY)) || {};
  stored[window.adminActivePart] = { stepsData: window.adminStepsData };
  await idbSet(STORAGE_KEY, stored);
  await updateProfileDropdowns(false);
}

async function saveCurrentAdminProfileExplicit() {
  blurActiveInput();
  if (!window.adminActivePart) return alert('品番を選択してください');
  await autoSaveAdminProfile();
  alert(`品番 [ ${window.adminActivePart} ] の検査ステップ設定を保存しました。`);
}

async function deleteAdminProfile() {
  blurActiveInput();
  if (!window.adminActivePart) return;
  if (!confirm(`品番 [ ${window.adminActivePart} ] を削除しますか？`)) return;
  const stored = (await idbGet(STORAGE_KEY)) || {};
  delete stored[window.adminActivePart];
  await idbSet(STORAGE_KEY, stored);
  window.adminActivePart = '';
  window.adminStepsData = [];
  await updateProfileDropdowns(false);
  renderAdminStepsList();
}

function renderAdminStepsList() {
  const container = document.getElementById('adminStepsContainer');
  if (!window.adminActivePart) {
    container.innerHTML = '<p style="font-size:0.85rem; color:var(--muted);">上の検索欄またはプルダウンから品番を選択するか、CSVを取り込んでください。</p>';
    return;
  }

  container.innerHTML = window.adminStepsData.map((s, idx) => {
    const isSel = idx === selectedAdminStepIdx ? 'selected' : '';
    const originBadge = s.fromCsv
      ? `<span style="font-size:0.72rem; background:var(--primary-light); color:var(--primary-dark); padding:2px 6px; border-radius:4px; font-weight:700;">CSV連携${s.refName ? ` (${s.refName})` : ''}</span>`
      : `<span style="font-size:0.72rem; background:var(--ai-light); color:var(--ai-color); padding:2px 6px; border-radius:4px; font-weight:700;">追加ステップ</span>`;

    return `
      <div class="step-admin-item ${isSel} ${s.fromCsv ? 'from-csv' : 'custom-step'}" onclick="selectAdminStep(${idx})">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:4px; flex-wrap:wrap;">
          <strong>Step ${idx + 1}: 【 ${s.name} 】 ${originBadge}</strong>
          <div style="display:flex; gap:4px;">
            <button class="btn" style="padding:2px 7px;" onclick="event.stopPropagation(); moveAdminStep(${idx}, -1)">▲</button>
            <button class="btn" style="padding:2px 7px;" onclick="event.stopPropagation(); moveAdminStep(${idx}, 1)">▼</button>
            <button class="btn btn-danger" style="padding:2px 7px;" onclick="event.stopPropagation(); deleteAdminStep(${idx})">✕</button>
          </div>
        </div>

        <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:0.8rem;">
          <label>名称:</label>
          <input type="text" value="${s.name}" style="width:110px; padding:4px;" onclick="event.stopPropagation();" onchange="updateAdminStepField(${idx}, 'name', this.value)">
          <label>種別:</label>
          <select style="padding:4px;" onclick="event.stopPropagation();" ontouchstart="event.stopPropagation();" onchange="updateAdminStepField(${idx}, 'type', this.value)">
            <option value="BARCODE" ${s.type === 'BARCODE' ? 'selected' : ''}>📷 QR/バーコード照合</option>
            <option value="BAKERY" ${s.type === 'BAKERY' ? 'selected' : ''}>🥐 パン屋AI照合</option>
          </select>
        </div>

        ${s.type === 'BARCODE' ? `
          <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:0.8rem;">
            <label>正解コード:</label>
            <input type="text" value="${s.expectedBarcode || ''}" style="flex:1; padding:4px;" onclick="event.stopPropagation();" onchange="updateAdminStepField(${idx}, 'expectedBarcode', this.value)">
            <button class="btn btn-primary" style="padding:4px 8px; font-size:0.75rem;" onclick="event.stopPropagation(); captureExpectedBarcodeFromCam(${idx})">🎯 枠内コード読取</button>
          </div>
        ` : `
          <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:0.8rem;">
            <label>合格一致率(%):</label>
            <input type="number" value="${s.bakeryThreshold || 80}" min="50" max="99" style="width:70px; padding:4px;" onclick="event.stopPropagation();" onchange="updateAdminStepField(${idx}, 'bakeryThreshold', parseInt(this.value,10))">
            <span>良品数: <strong>${(s.bakerySamples || []).length}</strong>枚</span>
            <button class="btn btn-ai" style="padding:4px 8px; font-size:0.75rem;" onclick="event.stopPropagation(); registerBakerySample(${idx})">📸 良品マスター追加</button>
            <button class="btn" style="padding:4px 8px; font-size:0.75rem;" onclick="event.stopPropagation(); clearBakerySamples(${idx})">クリア</button>
          </div>
        `}
      </div>
    `;
  }).join('');
}

function selectAdminStep(idx) {
  selectedAdminStepIdx = idx;
  renderAdminStepsList();
  drawAdminCanvas();
}

async function updateAdminStepField(idx, field, val) {
  if (!window.adminStepsData[idx]) return;
  window.adminStepsData[idx][field] = val;
  await autoSaveAdminProfile();
  renderAdminStepsList();
  drawAdminCanvas();
}

async function moveAdminStep(idx, dir) {
  const target = idx + dir;
  if (target < 0 || target >= window.adminStepsData.length) return;
  const temp = window.adminStepsData[idx];
  window.adminStepsData[idx] = window.adminStepsData[target];
  window.adminStepsData[target] = temp;
  selectedAdminStepIdx = target;
  await autoSaveAdminProfile();
  renderAdminStepsList();
  drawAdminCanvas();
}

async function deleteAdminStep(idx) {
  window.adminStepsData.splice(idx, 1);
  selectedAdminStepIdx = Math.max(0, window.adminStepsData.length - 1);
  await autoSaveAdminProfile();
  renderAdminStepsList();
  drawAdminCanvas();
}

async function addAdminCustomStep(type) {
  blurActiveInput();
  if (!window.adminActivePart) return alert('先に品番を選択または新規作成してください');
  window.adminStepsData.push({
    name: type === 'BAKERY' ? `ワーク外観 ${window.adminStepsData.length + 1}` : `追加コード ${window.adminStepsData.length + 1}`,
    type: type,
    fromCsv: false,
    isFullFrame: true,
    x: 0, y: 0, w: adminCanvas.width, h: adminCanvas.height,
    baseW: adminCanvas.width, baseH: adminCanvas.height,
    bakerySamples: [],
    bakeryThreshold: 80,
    expectedBarcode: ''
  });
  selectedAdminStepIdx = window.adminStepsData.length - 1;
  await autoSaveAdminProfile();
  renderAdminStepsList();
  drawAdminCanvas();
}

async function duplicateSelectedStep() {
  const cur = window.adminStepsData[selectedAdminStepIdx];
  if (!cur) return;
  const copy = JSON.parse(JSON.stringify(cur));
  copy.name = cur.name + '_複製';
  copy.fromCsv = false;
  window.adminStepsData.push(copy);
  selectedAdminStepIdx = window.adminStepsData.length - 1;
  await autoSaveAdminProfile();
  renderAdminStepsList();
  drawAdminCanvas();
}

async function setSelectedStepFullFrame() {
  const cur = window.adminStepsData[selectedAdminStepIdx];
  if (!cur) return;
  cur.isFullFrame = true;
  cur.x = 0; cur.y = 0;
  cur.w = adminCanvas.width; cur.h = adminCanvas.height;
  cur.baseW = adminCanvas.width; cur.baseH = adminCanvas.height;
  await autoSaveAdminProfile();
  drawAdminCanvas();
}

async function nudgeAdminStep(dx, dy, dw, dh) {
  const s = window.adminStepsData[selectedAdminStepIdx];
  if (!s) return;
  s.isFullFrame = false;
  s.baseW = adminCanvas.width;
  s.baseH = adminCanvas.height;
  s.x = Math.max(0, Math.min(adminCanvas.width - 40, (s.x || 0) + dx));
  s.y = Math.max(0, Math.min(adminCanvas.height - 40, (s.y || 0) + dy));
  s.w = Math.max(40, Math.min(adminCanvas.width - s.x, (s.w || adminCanvas.width) + dw));
  s.h = Math.max(40, Math.min(adminCanvas.height - s.y, (s.h || adminCanvas.height) + dh));
  await autoSaveAdminProfile();
  drawAdminCanvas();
}

async function registerBakerySample(idx) {
  if (!isCamRunning) return alert('先に「📷 設定用カメラ起動」を押してください');
  const s = window.adminStepsData[idx];
  const vec = await extractBakeryFeatureVector(adminCanvas, s);
  if (!s.bakerySamples) s.bakerySamples = [];
  s.bakerySamples.push(vec);
  playBuzzerPattern('OK');
  await autoSaveAdminProfile();
  renderAdminStepsList();
}

async function clearBakerySamples(idx) {
  window.adminStepsData[idx].bakerySamples = [];
  await autoSaveAdminProfile();
  renderAdminStepsList();
}

async function captureExpectedBarcodeFromCam(idx) {
  if (!isCamRunning) return alert('先に「📷 設定用カメラ起動」を押してください');
  const s = window.adminStepsData[idx];
  const res = await detectBarcodeFromCanvas(adminCanvas, s);
  if (!res) return alert('枠内からコードを読み取れませんでした');
  s.expectedBarcode = applyQrSubstring(res.value, res.isQr);
  playBuzzerPattern('OK');
  await autoSaveAdminProfile();
  renderAdminStepsList();
}

function setupCanvasTouchAndMouse() {
  function getCoords(e) {
    const rect = adminCanvas.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: Math.round((cx - rect.left) * (adminCanvas.width / rect.width)),
      y: Math.round((cy - rect.top) * (adminCanvas.height / rect.height))
    };
  }
  function onStart(e) {
    if (e.touches && e.touches.length > 1) return;
    if (!window.adminStepsData[selectedAdminStepIdx]) return;
    if (e.cancelable) e.preventDefault();
    blurActiveInput();
    const p = getCoords(e);
    dragStartX = p.x; dragStartY = p.y;
    isDraggingRoi = true;
  }
  function onMove(e) {
    if (!isDraggingRoi) return;
    if (e.cancelable) e.preventDefault();
    const p = getCoords(e);
    const s = window.adminStepsData[selectedAdminStepIdx];
    if (!s) return;
    s.isFullFrame = false;
    s.baseW = adminCanvas.width; s.baseH = adminCanvas.height;
    s.x = Math.min(dragStartX, p.x);
    s.y = Math.min(dragStartY, p.y);
    s.w = Math.max(30, Math.abs(p.x - dragStartX));
    s.h = Math.max(30, Math.abs(p.y - dragStartY));
    drawAdminCanvas();
  }
  async function onEnd() {
    if (!isDraggingRoi) return;
    isDraggingRoi = false;
    await autoSaveAdminProfile();
  }
  adminCanvas.addEventListener('mousedown', onStart);
  adminCanvas.addEventListener('mousemove', onMove);
  adminCanvas.addEventListener('mouseup', onEnd);
  adminCanvas.addEventListener('touchstart', onStart, { passive: false });
  adminCanvas.addEventListener('touchmove', onMove, { passive: false });
  adminCanvas.addEventListener('touchend', onEnd);
}

async function exportAllProfilesJson() {
  const data = {
    profiles: (await idbGet(STORAGE_KEY)) || {},
    csvTableA,
    csvTableB,
    qrRangeConfig,
    audioConfig
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pokayoke_master_backup_${Date.now()}.json`;
  a.click();
}

function importAllProfilesJson(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (evt) => {
    try {
      const obj = JSON.parse(evt.target.result);
      if (obj.profiles) await idbSet(STORAGE_KEY, obj.profiles);
      if (obj.csvTableA) { csvTableA = obj.csvTableA; await idbSet(TABLE_A_KEY, csvTableA); }
      if (obj.csvTableB) { csvTableB = obj.csvTableB; await idbSet(TABLE_B_KEY, csvTableB); }
      if (obj.qrRangeConfig) { qrRangeConfig = obj.qrRangeConfig; localStorage.setItem(QR_CONFIG_KEY, JSON.stringify(qrRangeConfig)); }
      if (obj.audioConfig) { audioConfig = obj.audioConfig; localStorage.setItem(AUDIO_CONFIG_KEY, JSON.stringify(audioConfig)); applyAudioConfigToUI(); }
      await updateProfileDropdowns(false);
      alert('JSON設定データを復元しました。');
    } catch (err) {
      alert('JSONファイルの形式が正しくありません。');
    }
  };
  reader.readAsText(file);
}

function setupKeyboardShortcuts() {
  document.getElementById('externalPartInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitExternalPartInput(); }
  });
  document.getElementById('workerStepBarcodeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleWorkerBarcodeInput(); }
  });
  const workerTopInp = document.getElementById('txtWorkerInput');
  if (workerTopInp) {
    workerTopInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); registerWorker(); }
    });
  }

  window.addEventListener('keydown', async (e) => {
    const tag = (e.target && e.target.tagName) ? e.target.tagName : '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (document.getElementById('ngOverlay').style.display === 'flex') return;

    if (e.code === 'Space' && activePage === 'inspectPage') {
      e.preventDefault();
      executeCurrentStepInspection();
      return;
    }

    const now = Date.now();
    if (now - headlessScannerLastTime > 500) {
      headlessScannerBuffer = '';
    }
    headlessScannerLastTime = now;

    if (e.key === 'Enter') {
      const scanned = normalizeCodeString(headlessScannerBuffer);
      headlessScannerBuffer = '';
      if (scanned.length >= 2) {
        e.preventDefault();
        // 作業者登録モーダル表示中は作業者IDとして登録
        const workerModal = document.getElementById('workerAuthModal');
        if (workerModal && workerModal.style.display === 'flex') {
          await completeWorkerModalRegistration(scanned);
          return;
        }
        if (activePage === 'partScanPage') {
          await tryStartInspectionWithPart(scanned);
        } else if (activePage === 'inspectPage' && !window.isChatteringCooldown && !isInspectingStep) {
          const step = window.currentSteps[window.currentStepIdx];
          if (step && step.type === 'BARCODE') {
            verifyStepBarcodeValue(scanned, false, step);
          }
        }
      }
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      headlessScannerBuffer += e.key;
    }
  });
}
