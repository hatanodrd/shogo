// =========================================================
// app_admin.js : 画面遷移・材料マスター画面・製品ステップへの材料マスター紐づけ
// =========================================================
window.adminActivePart = '';
window.adminStepsData = [];
let selectedAdminStepIdx = 0;
let isDraggingRoi = false;
let dragStartX = 0, dragStartY = 0;

// 材料マスター管理用の状態変数
window.materialMastersCache = {};
window.activeMaterialCode = '';
let materialSearchQuery = '';
let isDraggingMatRoi = false;
let matDragStartX = 0, matDragStartY = 0;

let headlessScannerBuffer = '';
let headlessScannerLastTime = 0;

// 製品設定画面の品番検索キーワード
let adminPartSearchQuery = '';

const video = document.getElementById('videoSource');
const mainCanvas = document.getElementById('mainCanvas');
const mainCtx = mainCanvas.getContext('2d', { willReadFrequently: true });
const adminCanvas = document.getElementById('adminCanvas');
const adminCtx = adminCanvas.getContext('2d', { willReadFrequently: true });

window.addEventListener('DOMContentLoaded', async () => {
  await loadSavedConfigs();
  injectMaterialMasterPageAndMenu();
  injectAdminPartSearchUI();
  setupCanvasTouchAndMouse();
  setupMaterialCanvasTouchAndMouse();
  setupKeyboardShortcuts();
  await updateProfileDropdowns();
  await updateMaterialMasterDropdowns();
  await initAI();
});

async function navigateTo(pageId) {
  blurActiveInput();
  headlessScannerBuffer = '';

  // 検査画面へ入る際、作業者IDが未登録なら登録モーダルを強制表示
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

  // トップ画面へ戻った場合、作業者IDを「未登録」にリセット
  if (pageId === 'topMenuPage' && typeof clearWorkerRegistration === 'function') {
    clearWorkerRegistration();
  }

  document.querySelectorAll('.page-view').forEach(p => p.classList.remove('active'));
  const targetEl = document.getElementById(pageId);
  if (targetEl) targetEl.classList.add('active');
  activePage = pageId;

  document.getElementById('btnBackToTop').style.display = (pageId === 'topMenuPage') ? 'none' : 'inline-flex';
  document.getElementById('btnBackToPartScan').style.display = (pageId === 'inspectPage') ? 'inline-flex' : 'none';

  await updateProfileDropdowns();
  await updateMaterialMasterDropdowns();

  if (pageId === 'inspectPage') {
    await startMainCamera();
  } else if (pageId === 'adminPage') {
    renderAdminStepsList();
    drawAdminCanvas();
  } else if (pageId === 'materialMasterPage') {
    renderMaterialEditorPanel();
    drawMaterialCanvas();
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
    const matCanvas = document.getElementById('materialCanvas');
    if (matCanvas) {
      matCanvas.width = mainCanvas.width;
      matCanvas.height = mainCanvas.height;
    }
    isCamRunning = true;
    const btnAdminCam = document.getElementById('btnAdminCam');
    if (btnAdminCam) btnAdminCam.textContent = '⏹ カメラ停止';
    const btnMatCam = document.getElementById('btnMaterialCam');
    if (btnMatCam) btnMatCam.textContent = '⏹ カメラ停止';
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
  const btnMatCam = document.getElementById('btnMaterialCam');
  if (btnMatCam) btnMatCam.textContent = '📷 材料撮影用カメラ起動';
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
  } else if (activePage === 'materialMasterPage') {
    drawMaterialCanvas();
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
// 🥐 材料マスター登録・編集画面の動的生成 ＆ 管理ロジック
// =========================================================
function injectMaterialMasterPageAndMenu() {
  // 1. トップ画面のメニューに「🥐 材料マスターの登録・編集」ボタンを追加
  const topPage = document.getElementById('topMenuPage');
  if (topPage && !document.getElementById('btnMenuMaterialMaster')) {
    const menuGrid = topPage.querySelector('.menu-grid');
    if (menuGrid) {
      const matBtn = document.createElement('button');
      matBtn.id = 'btnMenuMaterialMaster';
      matBtn.className = 'btn btn-ai menu-hero-btn';
      matBtn.onclick = () => navigateTo('materialMasterPage');
      matBtn.innerHTML = `
        <span>🥐 パン屋AI 材料マスターの登録・編集（管理者用）</span>
        <span class="sub">材料品番の新規作成・検索・変更、良品マスター画像の撮影登録を行います（現在: <strong id="topMaterialCount">0</strong> 件）</span>
      `;
      // 作業者ボタンと管理者設定ボタンの間に挿入
      menuGrid.insertBefore(matBtn, menuGrid.children[1] || null);
    }
  }

  // 2. 材料マスター登録画面（#materialMasterPage）をbodyに追加
  if (!document.getElementById('materialMasterPage')) {
    const matPage = document.createElement('main');
    matPage.className = 'page-view';
    matPage.id = 'materialMasterPage';
    matPage.innerHTML = `
      <div class="nav-banner" style="background:var(--ai-light); color:var(--ai-color); border-left-color:var(--ai-color);">
        🥐 パン屋AI 材料マスター登録・編集画面（ここで登録した材料マスターを各製品の検査ステップに紐づけます）
      </div>

      <div class="card">
        <div class="card-title" style="color:var(--ai-color); border-left-color:var(--ai-color);">
          ① 材料品番の検索・新規追加・名称変更
        </div>

        <!-- 材料品番の検索枠 -->
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px; background:#f3e5f5; padding:8px 10px; border-radius:8px; border:1px solid #ce93d8;">
          <span style="font-size:0.85rem; font-weight:700; color:var(--ai-color);">🔎 材料品番を検索:</span>
          <input type="text" id="txtMaterialSearch" placeholder="材料品番や名称の一部を入力して絞り込み..." style="flex:1; min-width:180px; padding:6px 10px;" autocomplete="off">
          <span id="lblMaterialSearchCount" style="font-size:0.8rem; font-weight:700; color:var(--ai-color);">全 0 件</span>
          <button type="button" class="btn" style="padding:5px 10px; font-size:0.78rem;" onclick="clearMaterialSearch()">クリア</button>
        </div>

        <!-- 既存選択 ＆ 新規作成 -->
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
          <select id="selMaterialMaster" style="flex:1; min-width:220px;" onchange="loadMaterialMaster(this.value)">
            <option value="">-- 編集・確認する材料マスターを選択 --</option>
          </select>
          <input type="text" id="txtNewMaterialCode" placeholder="新規材料品番を入力 (例: MAT-01)" style="width:210px;">
          <button type="button" class="btn btn-ai" onclick="createOrSwitchMaterialMaster()">＋ 新規材料を追加 / 切替</button>
          <button type="button" class="btn btn-danger" onclick="deleteCurrentMaterialMaster()">🗑️ この材料を削除</button>
        </div>

        <!-- 選択中の材料品番の名称変更・備考編集バー -->
        <div id="materialRenameBar" style="display:none; gap:8px; align-items:center; flex-wrap:wrap; padding:8px 10px; background:#fafafa; border:1px dashed var(--border); border-radius:8px;">
          <span style="font-size:0.82rem; font-weight:700;">✏️ 選択中の材料品番を変更:</span>
          <input type="text" id="txtRenameMaterialCode" placeholder="変更後の材料品番" style="width:170px; padding:5px 8px;">
          <span style="font-size:0.82rem; font-weight:700;">材料メモ/名称:</span>
          <input type="text" id="txtMaterialMemo" placeholder="例: M6袋ナット / 黒ゴムパッキン" style="flex:1; min-width:160px; padding:5px 8px;" onchange="saveCurrentMaterialMaster()">
          <button type="button" class="btn btn-primary" style="padding:5px 10px; font-size:0.8rem;" onclick="renameCurrentMaterialMaster()">品番名・メモを更新</button>
        </div>
      </div>

      <!-- ② カメラ映像 ＆ 良品マスター登録エリア -->
      <div class="card">
        <div class="card-title" style="color:var(--ai-color); border-left-color:var(--ai-color);">
          ② 材料の検査枠設定 ＆ 良品マスター画像の撮影・変更
        </div>

        <div class="admin-layout">
          <div style="display:flex; flex-direction:column; gap:8px;">
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button type="button" class="btn btn-ai" id="btnMaterialCam" onclick="toggleAdminCamera()">📷 材料撮影用カメラ起動</button>
              <button type="button" class="btn" onclick="setMaterialFullFrame()">🔲 枠をカメラ全体(100%)に戻す</button>
            </div>

            <div class="viewport-box">
              <canvas id="materialCanvas" width="640" height="480" style="width:100%; height:100%; object-fit:contain; display:block; touch-action:none; cursor:crosshair;"></canvas>
            </div>

            <div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:center;">
              <button type="button" class="btn" onclick="nudgeMaterialRoi(-10,0,0,0)">← 左</button>
              <button type="button" class="btn" onclick="nudgeMaterialRoi(10,0,0,0)">→ 右</button>
              <button type="button" class="btn" onclick="nudgeMaterialRoi(0,-10,0,0)">↑ 上</button>
              <button type="button" class="btn" onclick="nudgeMaterialRoi(0,10,0,0)">↓ 下</button>
              <button type="button" class="btn" onclick="nudgeMaterialRoi(0,0,15,0)">幅＋</button>
              <button type="button" class="btn" onclick="nudgeMaterialRoi(0,0,-15,0)">幅－</button>
              <button type="button" class="btn" onclick="nudgeMaterialRoi(0,0,0,15)">高＋</button>
              <button type="button" class="btn" onclick="nudgeMaterialRoi(0,0,0,-15)">高－</button>
            </div>
          </div>

          <div style="display:flex; flex-direction:column; gap:12px;">
            <div id="materialEditorContainer" style="background:#fdfbfe; border:1.5px solid #ce93d8; border-radius:10px; padding:14px; display:flex; flex-direction:column; gap:12px;">
              <p style="font-size:0.88rem; color:var(--muted);">上のリストから材料品番を選択するか、新規材料品番を追加してください。</p>
            </div>

            <div class="card" style="background:#f8fafc; margin-top:auto;">
              <div style="font-size:0.82rem; color:var(--muted); line-height:1.5;">
                💡 <strong>材料マスターの使いかた:</strong><br>
                1. ここで材料品番ごとに「良品マスター画像（複数角度・照明条件で3〜5枚推奨）」を撮影・登録します。<br>
                2. 「⚙️ 検査項目の登録・システム設定」画面を開き、各製品品番のステップで「＋ 🥐 登録済み材料マスターから追加」を選ぶだけで簡単に紐づけできます。
              </div>
              <div style="margin-top:10px; display:flex; justify-content:flex-end;">
                <button type="button" class="btn btn-dark" onclick="navigateTo('adminPage')">⚙️ 製品ごとの設定画面へ移動 ➔</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(matPage);

    const searchInp = document.getElementById('txtMaterialSearch');
    searchInp.addEventListener('input', async (e) => {
      materialSearchQuery = e.target.value;
      await updateMaterialMasterDropdowns(true);
    });
  }
}

async function clearMaterialSearch() {
  materialSearchQuery = '';
  const inp = document.getElementById('txtMaterialSearch');
  if (inp) inp.value = '';
  await updateMaterialMasterDropdowns(false);
}

async function updateMaterialMasterDropdowns(fromSearch = false) {
  const materials = (await idbGet(MATERIAL_MASTER_KEY)) || {};
  window.materialMastersCache = materials;
  const allKeys = Object.keys(materials).sort();

  const topCnt = document.getElementById('topMaterialCount');
  if (topCnt) topCnt.textContent = allKeys.length;

  const qNorm = normalizeCodeString(materialSearchQuery);
  const qUnified = (typeof unifyAmbiguousCharsKey === 'function') ? unifyAmbiguousCharsKey(qNorm) : qNorm;

  const filteredKeys = !qNorm ? allKeys : allKeys.filter(k => {
    const mat = materials[k] || {};
    const kNorm = normalizeCodeString(k);
    const memoNorm = normalizeCodeString(mat.memo || '');
    if (kNorm.includes(qNorm) || memoNorm.includes(qNorm)) return true;
    if (typeof unifyAmbiguousCharsKey === 'function') {
      return unifyAmbiguousCharsKey(kNorm).includes(qUnified);
    }
    return false;
  });

  const cntLbl = document.getElementById('lblMaterialSearchCount');
  if (cntLbl) {
    cntLbl.textContent = qNorm
      ? `該当 ${filteredKeys.length} / ${allKeys.length} 件`
      : `全 ${allKeys.length} 件`;
  }

  const sel = document.getElementById('selMaterialMaster');
  if (sel) {
    const opts = filteredKeys.map(k => {
      const m = materials[k];
      const memoStr = m.memo ? ` [${m.memo}]` : '';
      const cnt = (m.bakerySamples || []).length;
      return `<option value="${k}">${k}${memoStr} (良品:${cnt}枚 / 基準:${m.bakeryThreshold || 80}%)</option>`;
    }).join('');
    sel.innerHTML = `<option value="">-- 編集・確認する材料マスターを選択 (${filteredKeys.length}件) --</option>` + opts;

    if (fromSearch && qNorm && filteredKeys.length > 0) {
      const target = filteredKeys.includes(window.activeMaterialCode) ? window.activeMaterialCode : filteredKeys[0];
      sel.value = target;
      window.activeMaterialCode = target;
      renderMaterialEditorPanel();
      drawMaterialCanvas();
    } else if (window.activeMaterialCode && materials[window.activeMaterialCode] && filteredKeys.includes(window.activeMaterialCode)) {
      sel.value = window.activeMaterialCode;
    }
  }
}

async function createOrSwitchMaterialMaster() {
  blurActiveInput();
  const rawName = document.getElementById('txtNewMaterialCode')?.value;
  const code = normalizeCodeString(rawName);
  if (!code) return alert('新規作成または切り替える「材料品番」を入力してください');

  const materials = (await idbGet(MATERIAL_MASTER_KEY)) || {};
  if (!materials[code]) {
    materials[code] = {
      code: code,
      memo: '',
      isFullFrame: true,
      x: 0, y: 0, w: 640, h: 480,
      baseW: 640, baseH: 480,
      bakerySamples: [],
      bakeryThreshold: 80,
      updatedAt: new Date().toLocaleString('ja-JP')
    };
    await idbSet(MATERIAL_MASTER_KEY, materials);
  }
  document.getElementById('txtNewMaterialCode').value = '';
  await clearMaterialSearch();
  await loadMaterialMaster(code);
}

async function loadMaterialMaster(code) {
  blurActiveInput();
  if (!code) {
    window.activeMaterialCode = '';
    renderMaterialEditorPanel();
    drawMaterialCanvas();
    return;
  }
  const materials = (await idbGet(MATERIAL_MASTER_KEY)) || {};
  window.materialMastersCache = materials;
  if (!materials[code]) return;
  window.activeMaterialCode = code;
  const sel = document.getElementById('selMaterialMaster');
  if (sel) sel.value = code;
  renderMaterialEditorPanel();
  drawMaterialCanvas();
}

async function saveCurrentMaterialMaster() {
  if (!window.activeMaterialCode) return;
  const materials = (await idbGet(MATERIAL_MASTER_KEY)) || {};
  const cur = materials[window.activeMaterialCode];
  if (!cur) return;

  const memoInp = document.getElementById('txtMaterialMemo');
  if (memoInp) cur.memo = memoInp.value.trim();
  cur.updatedAt = new Date().toLocaleString('ja-JP');

  await idbSet(MATERIAL_MASTER_KEY, materials);
  window.materialMastersCache = materials;
  await updateMaterialMasterDropdowns(false);
}

async function renameCurrentMaterialMaster() {
  blurActiveInput();
  if (!window.activeMaterialCode) return;
  const oldCode = window.activeMaterialCode;
  const newCode = normalizeCodeString(document.getElementById('txtRenameMaterialCode')?.value);
  const newMemo = document.getElementById('txtMaterialMemo')?.value.trim() || '';

  if (!newCode) return alert('変更後の材料品番を入力してください');

  const materials = (await idbGet(MATERIAL_MASTER_KEY)) || {};
  if (!materials[oldCode]) return;

  if (newCode !== oldCode && materials[newCode]) {
    if (!confirm(`材料品番 [ ${newCode} ] は既に存在します。上書き統合しますか？`)) return;
  }

  const matData = materials[oldCode];
  matData.code = newCode;
  matData.memo = newMemo;
  matData.updatedAt = new Date().toLocaleString('ja-JP');

  if (newCode !== oldCode) {
    materials[newCode] = matData;
    delete materials[oldCode];

    // 製品プロファイル側で oldCode を参照しているステップも自動的に newCode へ更新
    const profiles = (await idbGet(STORAGE_KEY)) || {};
    let linkedUpdated = 0;
    Object.keys(profiles).forEach(pKey => {
      (profiles[pKey].stepsData || []).forEach(s => {
        if (s.materialCode === oldCode) {
          s.materialCode = newCode;
          if (s.name === oldCode) s.name = newCode;
          linkedUpdated++;
        }
      });
    });
    if (linkedUpdated > 0) {
      await idbSet(STORAGE_KEY, profiles);
    }
  }

  await idbSet(MATERIAL_MASTER_KEY, materials);
  window.activeMaterialCode = newCode;
  await updateMaterialMasterDropdowns(false);
  renderMaterialEditorPanel();
  drawMaterialCanvas();
  alert(`材料マスター [ ${newCode} ] の情報を更新しました。`);
}

async function deleteCurrentMaterialMaster() {
  blurActiveInput();
  if (!window.activeMaterialCode) return alert('削除する材料マスターを選択してください');
  if (!confirm(`材料マスター [ ${window.activeMaterialCode} ] を削除しますか？`)) return;

  const materials = (await idbGet(MATERIAL_MASTER_KEY)) || {};
  delete materials[window.activeMaterialCode];
  await idbSet(MATERIAL_MASTER_KEY, materials);

  window.activeMaterialCode = '';
  await updateMaterialMasterDropdowns(false);
  renderMaterialEditorPanel();
  drawMaterialCanvas();
}

function renderMaterialEditorPanel() {
  const container = document.getElementById('materialEditorContainer');
  const renameBar = document.getElementById('materialRenameBar');
  if (!container) return;

  const mat = window.materialMastersCache[window.activeMaterialCode];
  if (!window.activeMaterialCode || !mat) {
    if (renameBar) renameBar.style.display = 'none';
    container.innerHTML = '<p style="font-size:0.88rem; color:var(--muted);">上の検索欄・プルダウンから材料品番を選択するか、新規材料品番を入力して「＋ 新規材料を追加」を押してください。</p>';
    return;
  }

  if (renameBar) {
    renameBar.style.display = 'flex';
    document.getElementById('txtRenameMaterialCode').value = window.activeMaterialCode;
    document.getElementById('txtMaterialMemo').value = mat.memo || '';
  }

  const sampleCnt = (mat.bakerySamples || []).length;
  const th = mat.bakeryThreshold || 80;

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; border-bottom:1px solid #e1bee7; padding-bottom:8px;">
      <div>
        <span style="font-size:0.78rem; color:var(--muted);">選択中の材料マスター:</span>
        <div style="font-size:1.2rem; font-weight:700; color:var(--ai-color);">🥐 ${window.activeMaterialCode} ${mat.memo ? `<span style="font-size:0.9rem; color:var(--text);">(${mat.memo})</span>` : ''}</div>
      </div>
      <span style="font-size:0.75rem; background:#f3e5f5; color:var(--ai-color); padding:4px 8px; border-radius:6px; font-weight:700;">
        最終更新: ${mat.updatedAt || '---'}
      </span>
    </div>

    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
      <label style="font-size:0.9rem; font-weight:700;">🎯 標準の合格一致率 (%):</label>
      <div style="display:flex; align-items:center; gap:8px;">
        <input type="number" id="numMatThreshold" value="${th}" min="50" max="99" style="width:85px; font-weight:700; text-align:center;" onchange="updateMaterialThreshold(this.value)">
        <span style="font-size:0.82rem; color:var(--muted);">% 以上で合格</span>
      </div>
    </div>

    <div style="background:#ffffff; border:1px solid #ce93d8; border-radius:8px; padding:12px; display:flex; flex-direction:column; gap:10px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:0.9rem; font-weight:700;">📸 登録済み良品マスター数:</span>
        <strong style="font-size:1.25rem; color:${sampleCnt > 0 ? 'var(--success)' : 'var(--danger)'};">${sampleCnt} 枚</strong>
      </div>

      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button type="button" class="btn btn-ai" style="flex:1.5; padding:12px; font-size:0.95rem;" onclick="captureMaterialMasterSample()">
          📸 現在のカメラ枠内を「良品マスター」として追加
        </button>
        <button type="button" class="btn btn-danger" style="padding:12px;" onclick="clearMaterialMasterSamples()">
          🗑️ 良品データを全クリア
        </button>
      </div>

      <button type="button" class="btn btn-primary" style="padding:10px;" onclick="testCurrentMaterialMasterLive()">
        🔍 今のカメラ映像でこの材料マスターをテスト照合する
      </button>
      <div id="lblMaterialTestResult" style="font-size:0.88rem; font-weight:700; text-align:center; min-height:1.2em;"></div>
    </div>

    <button type="button" class="btn btn-success" style="padding:12px; font-size:1rem;" onclick="saveMaterialMasterExplicit()">
      💾 この材料マスターの変更を保存
    </button>
  `;
}

async function updateMaterialThreshold(val) {
  const materials = (await idbGet(MATERIAL_MASTER_KEY)) || {};
  const mat = materials[window.activeMaterialCode];
  if (!mat) return;
  mat.bakeryThreshold = Math.max(50, Math.min(99, parseInt(val, 10) || 80));
  mat.updatedAt = new Date().toLocaleString('ja-JP');
  await idbSet(MATERIAL_MASTER_KEY, materials);
  window.materialMastersCache = materials;
  await updateMaterialMasterDropdowns(false);
}

async function captureMaterialMasterSample() {
  if (!isCamRunning) return alert('先に「📷 材料撮影用カメラ起動」を押してください');
  if (!window.activeMaterialCode) return alert('材料品番を選択してください');

  const materials = (await idbGet(MATERIAL_MASTER_KEY)) || {};
  const mat = materials[window.activeMaterialCode];
  if (!mat) return;

  const matCanvas = document.getElementById('materialCanvas');
  const vec = await extractBakeryFeatureVector(matCanvas, mat);
  if (!mat.bakerySamples) mat.bakerySamples = [];
  mat.bakerySamples.push(vec);
  mat.updatedAt = new Date().toLocaleString('ja-JP');

  await idbSet(MATERIAL_MASTER_KEY, materials);
  window.materialMastersCache = materials;
  playBuzzerPattern('OK');
  await updateMaterialMasterDropdowns(false);
  renderMaterialEditorPanel();
}

async function clearMaterialMasterSamples() {
  if (!window.activeMaterialCode) return;
  if (!confirm(`材料マスター [ ${window.activeMaterialCode} ] の良品学習データをすべてクリアしますか？`)) return;

  const materials = (await idbGet(MATERIAL_MASTER_KEY)) || {};
  const mat = materials[window.activeMaterialCode];
  if (!mat) return;
  mat.bakerySamples = [];
  mat.updatedAt = new Date().toLocaleString('ja-JP');

  await idbSet(MATERIAL_MASTER_KEY, materials);
  window.materialMastersCache = materials;
  await updateMaterialMasterDropdowns(false);
  renderMaterialEditorPanel();
}

async function testCurrentMaterialMasterLive() {
  if (!isCamRunning) return alert('先に「📷 材料撮影用カメラ起動」を押してください');
  const mat = window.materialMastersCache[window.activeMaterialCode];
  if (!mat || !mat.bakerySamples || mat.bakerySamples.length === 0) {
    return alert('先に「📸 良品マスターとして追加」で1枚以上登録してください');
  }
  const matCanvas = document.getElementById('materialCanvas');
  const feat = await extractBakeryFeatureVector(matCanvas, mat);
  let bestSim = 0;
  mat.bakerySamples.forEach(s => {
    const sim = computeCosineSimilarity(feat, s) * 100;
    if (sim > bestSim) bestSim = sim;
  });
  const score = Math.round(bestSim);
  const th = mat.bakeryThreshold || 80;
  const resEl = document.getElementById('lblMaterialTestResult');
  if (score >= th) {
    playBuzzerPattern('OK');
    if (resEl) {
      resEl.style.color = 'var(--success)';
      resEl.textContent = `✅ テスト判定: 合格！ (一致率 ${score}% / 基準 ${th}%)`;
    }
  } else {
    playBuzzerPattern('NG');
    if (resEl) {
      resEl.style.color = 'var(--danger)';
      resEl.textContent = `⚠️ テスト判定: NG (一致率 ${score}% / 基準 ${th}%)`;
    }
  }
}

async function saveMaterialMasterExplicit() {
  blurActiveInput();
  if (!window.activeMaterialCode) return alert('材料品番を選択してください');
  await saveCurrentMaterialMaster();
  alert(`材料マスター [ ${window.activeMaterialCode} ] を保存しました。\nこの材料を使用している全ての製品品番に自動反映されます。`);
}

function drawMaterialCanvas() {
  const matCanvas = document.getElementById('materialCanvas');
  if (!matCanvas) return;
  const ctx = matCanvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, matCanvas.width, matCanvas.height);

  if (isCamRunning && video.readyState >= 2) {
    ctx.drawImage(video, 0, 0, matCanvas.width, matCanvas.height);
  } else {
    ctx.fillStyle = '#263238';
    ctx.fillRect(0, 0, matCanvas.width, matCanvas.height);
    ctx.fillStyle = '#cfd8dc';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('「📷 材料撮影用カメラ起動」を押すと映像が表示されます', 40, matCanvas.height / 2);
  }

  const mat = window.materialMastersCache[window.activeMaterialCode];
  if (mat) {
    const dummyStep = {
      name: `${window.activeMaterialCode}${mat.memo ? ` (${mat.memo})` : ''}`,
      type: 'BAKERY',
      isFullFrame: mat.isFullFrame,
      x: mat.x, y: mat.y, w: mat.w, h: mat.h,
      baseW: mat.baseW || matCanvas.width,
      baseH: mat.baseH || matCanvas.height
    };
    drawSmartRoiOverlay(ctx, matCanvas.width, matCanvas.height, dummyStep, '材料マスター枠: ');
  }
}

async function setMaterialFullFrame() {
  if (!window.activeMaterialCode) return;
  const matCanvas = document.getElementById('materialCanvas');
  const materials = (await idbGet(MATERIAL_MASTER_KEY)) || {};
  const mat = materials[window.activeMaterialCode];
  if (!mat) return;
  mat.isFullFrame = true;
  mat.x = 0; mat.y = 0;
  mat.w = matCanvas.width; mat.h = matCanvas.height;
  mat.baseW = matCanvas.width; mat.baseH = matCanvas.height;
  await idbSet(MATERIAL_MASTER_KEY, materials);
  window.materialMastersCache = materials;
  drawMaterialCanvas();
}

async function nudgeMaterialRoi(dx, dy, dw, dh) {
  if (!window.activeMaterialCode) return;
  const matCanvas = document.getElementById('materialCanvas');
  const materials = (await idbGet(MATERIAL_MASTER_KEY)) || {};
  const mat = materials[window.activeMaterialCode];
  if (!mat) return;

  mat.isFullFrame = false;
  mat.baseW = matCanvas.width;
  mat.baseH = matCanvas.height;
  mat.x = Math.max(0, Math.min(matCanvas.width - 40, (mat.x || 0) + dx));
  mat.y = Math.max(0, Math.min(matCanvas.height - 40, (mat.y || 0) + dy));
  mat.w = Math.max(40, Math.min(matCanvas.width - mat.x, (mat.w || matCanvas.width) + dw));
  mat.h = Math.max(40, Math.min(matCanvas.height - mat.y, (mat.h || matCanvas.height) + dh));

  await idbSet(MATERIAL_MASTER_KEY, materials);
  window.materialMastersCache = materials;
  drawMaterialCanvas();
}

function setupMaterialCanvasTouchAndMouse() {
  const matCanvas = document.getElementById('materialCanvas');
  if (!matCanvas) return;

  function getCoords(e) {
    const rect = matCanvas.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: Math.round((cx - rect.left) * (matCanvas.width / rect.width)),
      y: Math.round((cy - rect.top) * (matCanvas.height / rect.height))
    };
  }
  function onStart(e) {
    if (e.touches && e.touches.length > 1) return;
    if (!window.activeMaterialCode || !window.materialMastersCache[window.activeMaterialCode]) return;
    if (e.cancelable) e.preventDefault();
    blurActiveInput();
    const p = getCoords(e);
    matDragStartX = p.x; matDragStartY = p.y;
    isDraggingMatRoi = true;
  }
  function onMove(e) {
    if (!isDraggingMatRoi) return;
    if (e.cancelable) e.preventDefault();
    const p = getCoords(e);
    const mat = window.materialMastersCache[window.activeMaterialCode];
    if (!mat) return;
    mat.isFullFrame = false;
    mat.baseW = matCanvas.width; mat.baseH = matCanvas.height;
    mat.x = Math.min(matDragStartX, p.x);
    mat.y = Math.min(matDragStartY, p.y);
    mat.w = Math.max(30, Math.abs(p.x - matDragStartX));
    mat.h = Math.max(30, Math.abs(p.y - matDragStartY));
    drawMaterialCanvas();
  }
  async function onEnd() {
    if (!isDraggingMatRoi) return;
    isDraggingMatRoi = false;
    const materials = (await idbGet(MATERIAL_MASTER_KEY)) || {};
    if (materials[window.activeMaterialCode] && window.materialMastersCache[window.activeMaterialCode]) {
      materials[window.activeMaterialCode] = window.materialMastersCache[window.activeMaterialCode];
      await idbSet(MATERIAL_MASTER_KEY, materials);
    }
  }
  matCanvas.addEventListener('mousedown', onStart);
  matCanvas.addEventListener('mousemove', onMove);
  matCanvas.addEventListener('mouseup', onEnd);
  matCanvas.addEventListener('touchstart', onStart, { passive: false });
  matCanvas.addEventListener('touchmove', onMove, { passive: false });
  matCanvas.addEventListener('touchend', onEnd);
}

// =========================================================
// 🔎 管理者用：製品の品番検索（部分一致フィルタ）＆ ステップへの材料マスター紐づけ
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
    <span style="font-size:0.85rem; font-weight:700; color:var(--primary-dark);">🔎 製品品番を検索:</span>
    <input type="text" id="txtAdminPartSearch" placeholder="製品品番の一部を入力して絞り込み..." style="flex:1; min-width:180px; padding:6px 10px;" autocomplete="off">
    <span id="lblAdminSearchHitCount" style="font-size:0.8rem; font-weight:700; color:var(--primary);">全 0 件</span>
    <button type="button" class="btn" style="padding:5px 10px; font-size:0.78rem;" onclick="clearAdminPartSearch()">クリア</button>
    <button type="button" class="btn btn-ai" style="padding:5px 10px; font-size:0.78rem;" onclick="navigateTo('materialMasterPage')">🥐 材料マスター登録画面へ</button>
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
  const materials = (await idbGet(MATERIAL_MASTER_KEY)) || {};
  window.materialMastersCache = materials;

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

  const wSel = document.getElementById('selWorkerProfile');
  const allOpts = allKeys.map(k => `<option value="${k}">${k} (${(stored[k].stepsData || []).length}ステップ)</option>`).join('');
  wSel.innerHTML = '<option value="">-- 登録済み品番を選択 --</option>' + allOpts;

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
    container.innerHTML = '<p style="font-size:0.85rem; color:var(--muted);">上の検索欄またはプルダウンから製品品番を選択するか、CSVを取り込んでください。</p>';
    return;
  }

  const materials = window.materialMastersCache || {};
  const matKeys = Object.keys(materials).sort();

  container.innerHTML = window.adminStepsData.map((s, idx) => {
    const isSel = idx === selectedAdminStepIdx ? 'selected' : '';
    const originBadge = s.fromCsv
      ? `<span style="font-size:0.72rem; background:var(--primary-light); color:var(--primary-dark); padding:2px 6px; border-radius:4px; font-weight:700;">CSV連携${s.refName ? ` (${s.refName})` : ''}</span>`
      : `<span style="font-size:0.72rem; background:var(--ai-light); color:var(--ai-color); padding:2px 6px; border-radius:4px; font-weight:700;">${s.type === 'BAKERY' ? '材料マスター照合' : '追加ステップ'}</span>`;

    // 材料マスター選択肢の構築
    const linkedMat = s.materialCode ? materials[s.materialCode] : null;
    const matSampleCnt = linkedMat ? (linkedMat.bakerySamples || []).length : (s.bakerySamples || []).length;
    const matOptions = `<option value="">-- 材料マスターを選択 (${matKeys.length}件) --</option>` +
      matKeys.map(mk => {
        const mObj = materials[mk];
        const mMemo = mObj.memo ? ` [${mObj.memo}]` : '';
        const cnt = (mObj.bakerySamples || []).length;
        return `<option value="${mk}" ${s.materialCode === mk ? 'selected' : ''}>${mk}${mMemo} (良品:${cnt}枚)</option>`;
      }).join('');

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
          <label>工程名:</label>
          <input type="text" value="${s.name}" style="width:120px; padding:4px;" onclick="event.stopPropagation();" onchange="updateAdminStepField(${idx}, 'name', this.value)">
          <label>種別:</label>
          <select style="padding:4px;" onclick="event.stopPropagation();" ontouchstart="event.stopPropagation();" onchange="updateAdminStepField(${idx}, 'type', this.value)">
            <option value="BARCODE" ${s.type === 'BARCODE' ? 'selected' : ''}>📷 QR/バーコード照合</option>
            <option value="BAKERY" ${s.type === 'BAKERY' ? 'selected' : ''}>🥐 パン屋AI (材料マスター照合)</option>
          </select>
        </div>

        ${s.type === 'BARCODE' ? `
          <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:0.8rem;">
            <label>正解コード:</label>
            <input type="text" value="${s.expectedBarcode || ''}" style="flex:1; padding:4px;" onclick="event.stopPropagation();" onchange="updateAdminStepField(${idx}, 'expectedBarcode', this.value)">
            <button class="btn btn-primary" style="padding:4px 8px; font-size:0.75rem;" onclick="event.stopPropagation(); captureExpectedBarcodeFromCam(${idx})">🎯 枠内コード読取</button>
          </div>
        ` : `
          <div style="background:#f3e5f5; border:1px solid #ce93d8; border-radius:6px; padding:8px; display:flex; flex-direction:column; gap:6px; font-size:0.8rem;" onclick="event.stopPropagation();">
            <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
              <label style="font-weight:700; color:var(--ai-color);">🥐 照合する材料マスター:</label>
              <input type="text" placeholder="🔎 材料絞り込み..." style="width:125px; padding:3px 6px; font-size:0.78rem;" oninput="filterStepMaterialSelect(${idx}, this.value)">
              <select id="selStepMat_${idx}" style="flex:1; min-width:170px; padding:4px;" ontouchstart="event.stopPropagation();" onchange="assignMaterialMasterToStep(${idx}, this.value)">
                ${matOptions}
              </select>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
              <span>
                状態: ${s.materialCode
                  ? (linkedMat ? `<strong style="color:var(--success);">✅ 材料 [${s.materialCode}] 連携中 (良品:${matSampleCnt}枚)</strong>` : `<strong style="color:var(--danger);">⚠️ 材料 [${s.materialCode}] が未登録</strong>`)
                  : `<span style="color:var(--muted);">材料マスター未選択 (個別良品:${matSampleCnt}枚)</span>`}
              </span>
              <div style="display:flex; gap:6px; align-items:center;">
                <label>合格一致率(%):</label>
                <input type="number" value="${s.bakeryThreshold || (linkedMat ? linkedMat.bakeryThreshold : 80)}" min="50" max="99" style="width:65px; padding:3px;" onchange="updateAdminStepField(${idx}, 'bakeryThreshold', parseInt(this.value,10))">
                <button type="button" class="btn btn-ai" style="padding:3px 8px; font-size:0.74rem;" onclick="openMaterialMasterFromStep('${s.materialCode || ''}')">✏️ 材料マスターを編集</button>
              </div>
            </div>
          </div>
        `}
      </div>
    `;
  }).join('');
}

// ステップ内の材料マスタープルダウンをキーワードで絞り込む
function filterStepMaterialSelect(stepIdx, query) {
  const sel = document.getElementById(`selStepMat_${stepIdx}`);
  if (!sel) return;
  const materials = window.materialMastersCache || {};
  const allKeys = Object.keys(materials).sort();
  const qNorm = normalizeCodeString(query);
  const filtered = !qNorm ? allKeys : allKeys.filter(k => {
    const m = materials[k] || {};
    return normalizeCodeString(k).includes(qNorm) || normalizeCodeString(m.memo || '').includes(qNorm);
  });
  const currentVal = window.adminStepsData[stepIdx]?.materialCode || '';
  sel.innerHTML = `<option value="">-- 材料マスターを選択 (${filtered.length}件) --</option>` +
    filtered.map(mk => {
      const mObj = materials[mk];
      const mMemo = mObj.memo ? ` [${mObj.memo}]` : '';
      const cnt = (mObj.bakerySamples || []).length;
      return `<option value="${mk}" ${currentVal === mk ? 'selected' : ''}>${mk}${mMemo} (良品:${cnt}枚)</option>`;
    }).join('');
}

// 選択した材料マスターを製品の検査ステップに紐づける
async function assignMaterialMasterToStep(stepIdx, matCode) {
  const step = window.adminStepsData[stepIdx];
  if (!step) return;
  step.materialCode = matCode || '';
  const mat = window.materialMastersCache[matCode];
  if (mat) {
    // 工程名が初期値のままなら材料品番（またはメモ）を自動でセット
    if (!step.name || step.name.startsWith('ワーク外観') || step.name.startsWith('材料照合')) {
      step.name = mat.memo ? `${matCode} (${mat.memo})` : matCode;
    }
    step.bakeryThreshold = mat.bakeryThreshold || 80;
    step.isFullFrame = mat.isFullFrame ?? true;
    step.x = mat.x || 0; step.y = mat.y || 0;
    step.w = mat.w || 640; step.h = mat.h || 480;
    step.baseW = mat.baseW || 640; step.baseH = mat.baseH || 480;
  }
  await autoSaveAdminProfile();
  renderAdminStepsList();
  drawAdminCanvas();
}

async function openMaterialMasterFromStep(matCode) {
  if (matCode && window.materialMastersCache[matCode]) {
    window.activeMaterialCode = matCode;
  }
  await navigateTo('materialMasterPage');
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
  if (!window.adminActivePart) return alert('先に製品品番を選択または新規作成してください');

  const materials = window.materialMastersCache || {};
  const matKeys = Object.keys(materials).sort();
  const defaultMatCode = (type === 'BAKERY' && matKeys.length > 0) ? matKeys[0] : '';
  const defaultMat = defaultMatCode ? materials[defaultMatCode] : null;

  window.adminStepsData.push({
    name: type === 'BAKERY'
      ? (defaultMatCode ? (defaultMat?.memo ? `${defaultMatCode} (${defaultMat.memo})` : defaultMatCode) : `材料照合 ${window.adminStepsData.length + 1}`)
      : `追加コード ${window.adminStepsData.length + 1}`,
    type: type,
    materialCode: defaultMatCode,
    fromCsv: false,
    isFullFrame: defaultMat ? (defaultMat.isFullFrame ?? true) : true,
    x: defaultMat ? (defaultMat.x || 0) : 0,
    y: defaultMat ? (defaultMat.y || 0) : 0,
    w: defaultMat ? (defaultMat.w || adminCanvas.width) : adminCanvas.width,
    h: defaultMat ? (defaultMat.h || adminCanvas.height) : adminCanvas.height,
    baseW: defaultMat ? (defaultMat.baseW || adminCanvas.width) : adminCanvas.width,
    baseH: defaultMat ? (defaultMat.baseH || adminCanvas.height) : adminCanvas.height,
    bakerySamples: [],
    bakeryThreshold: defaultMat ? (defaultMat.bakeryThreshold || 80) : 80,
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

// JSONバックアップ（材料マスターも一括で書き出し・復元）
async function exportAllProfilesJson() {
  const data = {
    profiles: (await idbGet(STORAGE_KEY)) || {},
    materialMasters: (await idbGet(MATERIAL_MASTER_KEY)) || {},
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
      if (obj.materialMasters) {
        await idbSet(MATERIAL_MASTER_KEY, obj.materialMasters);
        window.materialMastersCache = obj.materialMasters;
      }
      if (obj.csvTableA) { csvTableA = obj.csvTableA; await idbSet(TABLE_A_KEY, csvTableA); }
      if (obj.csvTableB) { csvTableB = obj.csvTableB; await idbSet(TABLE_B_KEY, csvTableB); }
      if (obj.qrRangeConfig) { qrRangeConfig = obj.qrRangeConfig; localStorage.setItem(QR_CONFIG_KEY, JSON.stringify(qrRangeConfig)); }
      if (obj.audioConfig) { audioConfig = obj.audioConfig; localStorage.setItem(AUDIO_CONFIG_KEY, JSON.stringify(audioConfig)); applyAudioConfigToUI(); }
      await updateProfileDropdowns(false);
      await updateMaterialMasterDropdowns(false);
      alert('JSON設定データ（製品ステップ＆材料マスター含む）を復元しました。');
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
