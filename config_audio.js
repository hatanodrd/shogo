// =========================================================
// config_audio.js : 定数・IndexedDB・材料マスターキー・文字同一視・作業者QR(対策③)・音声制御
// =========================================================
const DB_NAME = 'pokayoke_idb_v1';
const DB_STORE = 'app_data';

const STORAGE_KEY = 'pokayoke_step_profiles_v5';
const MATERIAL_MASTER_KEY = 'pokayoke_material_masters_v5';
const TABLE_A_KEY = 'pokayoke_csv_table_a_v5';
const TABLE_B_KEY = 'pokayoke_csv_table_b_v5';
const QR_CONFIG_KEY = 'pokayoke_qr_range_config_v5';
const CASE_CONFIG_KEY = 'pokayoke_ignore_case_v5';
const OZERO_CONFIG_KEY = 'pokayoke_ignore_ozero_v5';
const ONE_I_CONFIG_KEY = 'pokayoke_ignore_one_i_v5';
const OCR_CONFIG_KEY = 'pokayoke_ocr_default_config_v5';
const AUDIO_CONFIG_KEY = 'pokayoke_audio_config_v5';
const LOG_STORAGE_KEY = 'pokayoke_inspection_logs_v5';
const BOX_NAMES = ['外箱', '内箱', '小箱'];

let csvTableA = {};
let csvTableB = {};
let qrRangeConfig = { start: null, end: null };

// 大文字・小文字を無視するかどうかの設定（初期値: true = 区別しない）
let isIgnoreCase = true;

// OCRで「O（オー）」と「0（ゼロ）」を同一視するかどうかの設定（初期値: true = 区別しない）
let isIgnoreOandZero = true;

// OCRで「1（イチ）」と「I（アイ）/ l（エル）」を同一視するかどうかの設定（初期値: true = 区別しない）
let isIgnoreOneAndI = true;

// OCR初期値設定（横幅・高さ・影除去感度）
let ocrDefaultConfig = {
  width: 75,
  height: 14,
  shadow: 14
};

// 音声・ブザー設定
let isSpeechEnabled = true;
let audioConfig = {
  voiceURI: '',
  rate: 1.15,
  pitch: 1.0,
  volume: 1.0,
  buzzerPreset: 'STANDARD'
};
let availableVoices = [];

let isTorchOn = false;
let countOK = 0;
let countNG = 0;

let mobilenetModel = null;
let sharedBarcodeDetector = null;
if ('BarcodeDetector' in window) {
  try {
    sharedBarcodeDetector = new BarcodeDetector({
      formats: ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'itf', 'codabar', 'upc_a', 'upc_e']
    });
  } catch (e) {}
}
const reusableCropCanvas = document.createElement('canvas');
const reusableCropCtx = reusableCropCanvas.getContext('2d', { willReadFrequently: true });

let activePage = 'topMenuPage';
let camStream = null;
let isCamRunning = false;

// 作業者QRスキャナ制御用
let workerQrScanner = null;
let isWorkerQrLocked = false;
let pendingNavigatePageAfterWorker = null;

// =========================================================
// 🗄️ IndexedDB 非同期ラッパー（容量無制限ストレージ）
// =========================================================
function openAppDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openAppDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const store = tx.objectStore(DB_STORE);
    const req = store.get(key);
    req.onsuccess = () => {
      let res = req.result !== undefined ? req.result : null;
      if ((key === STORAGE_KEY || key === MATERIAL_MASTER_KEY) && res && typeof res === 'object' && isIgnoreCase) {
        const clone = Object.assign({}, res);
        Object.keys(res).forEach(k => {
          const upKey = String(k).normalize('NFKC').trim().toUpperCase();
          if (!clone[upKey]) clone[upKey] = res[k];
        });
        return resolve(clone);
      }
      resolve(res);
    };
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, val) {
  const db = await openAppDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    const req = store.put(val, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key) {
  const db = await openAppDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function blurActiveInput() {
  if (document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    document.activeElement.blur();
  }
}

// =========================================================
// 🔤 文字列正規化 ＆ O/0 および 1/I あいまい一致解決
// =========================================================
function normalizeCodeString(str) {
  if (!str) return '';
  const cleaned = String(str).normalize('NFKC').trim();
  return isIgnoreCase ? cleaned.toUpperCase() : cleaned;
}

function unifyAmbiguousCharsKey(str) {
  let s = normalizeCodeString(str);
  if (isIgnoreOandZero) {
    s = s.replace(/[Oo0]/g, '0');
  }
  if (isIgnoreOneAndI) {
    s = s.replace(/[1Iil|]/g, '1');
  }
  return s;
}

function findMatchingMasterPart(rawPartNo, storedProfiles) {
  const cleaned = normalizeCodeString(rawPartNo);
  if (!cleaned || !storedProfiles) return null;

  if (storedProfiles[cleaned]) return cleaned;

  if (isIgnoreOandZero || isIgnoreOneAndI) {
    const targetUnified = unifyAmbiguousCharsKey(cleaned);
    const keys = Object.keys(storedProfiles);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (unifyAmbiguousCharsKey(k) === targetUnified) {
        return k;
      }
    }
  }
  return null;
}

// =========================================================
// 👤 作業者ID管理（対策③：カメラ全体認識 ＆ 中央CSSガイド枠表示）
// =========================================================
function isWorkerRegistered() {
  const lbl = document.getElementById('lblWorker');
  if (!lbl) return false;
  const txt = lbl.textContent.trim();
  return txt !== '' && txt !== '未登録';
}

function clearWorkerRegistration() {
  const lbl = document.getElementById('lblWorker');
  if (lbl) {
    lbl.textContent = '未登録';
    lbl.style.color = 'var(--danger)';
  }
  const inp = document.getElementById('txtWorkerInput');
  if (inp) inp.value = '';
}

function setWorkerRegisteredValue(val) {
  const cleaned = String(val || '').normalize('NFKC').trim();
  if (!cleaned) return false;
  const lbl = document.getElementById('lblWorker');
  if (lbl) {
    lbl.textContent = cleaned;
    lbl.style.color = 'var(--success)';
  }
  const inp = document.getElementById('txtWorkerInput');
  if (inp) inp.value = '';
  const modalInp = document.getElementById('txtModalWorkerInput');
  if (modalInp) modalInp.value = '';
  playBuzzerPattern('OK');
  return true;
}

function registerWorker() {
  blurActiveInput();
  const val = document.getElementById('txtWorkerInput')?.value.trim();
  if (!val) {
    openWorkerQrModal(false);
    return;
  }
  setWorkerRegisteredValue(val);
}

function injectWorkerModalUI() {
  const workerInp = document.getElementById('txtWorkerInput');
  if (workerInp && !document.getElementById('btnOpenWorkerQr')) {
    const qrBtn = document.createElement('button');
    qrBtn.id = 'btnOpenWorkerQr';
    qrBtn.type = 'button';
    qrBtn.className = 'btn btn-dark';
    qrBtn.style.cssText = 'padding:4px 8px; font-size:0.78rem;';
    qrBtn.textContent = '📷 QR読取';
    qrBtn.onclick = () => openWorkerQrModal(false);
    workerInp.parentNode.appendChild(qrBtn);
  }

  // Androidでもvideoが枠全体にフィットして歪まないようスタイルを注入
  if (!document.getElementById('qrScannerFullFrameStyle')) {
    const st = document.createElement('style');
    st.id = 'qrScannerFullFrameStyle';
    st.textContent = `
      #workerQrReader video, #qrReaderPart video {
        width: 100% !important;
        height: 100% !important;
        object-fit: cover !important;
      }
      .custom-qr-guide-overlay {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        width: 68%;
        height: 68%;
        border: 3px solid #00e676;
        border-radius: 12px;
        box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.35);
        pointer-events: none;
        z-index: 20;
        display: flex;
        align-items: flex-end;
        justify-content: center;
        padding-bottom: 6px;
      }
      .custom-qr-guide-overlay span {
        background: rgba(0, 0, 0, 0.78);
        color: #00e676;
        font-size: 0.75rem;
        font-weight: 700;
        padding: 2px 8px;
        border-radius: 4px;
      }
    `;
    document.head.appendChild(st);
  }

  if (!document.getElementById('workerAuthModal')) {
    const modal = document.createElement('div');
    modal.id = 'workerAuthModal';
    modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.72); z-index:1100; display:none; align-items:center; justify-content:center; padding:16px;';
    modal.innerHTML = `
      <div class="card" style="max-width:480px; width:100%; display:flex; flex-direction:column; gap:12px; border:2px solid var(--primary);">
        <div class="card-title" style="margin-bottom:0;">👤 作業者ID（担当者コード）の登録</div>
        <p id="workerModalNotice" style="font-size:0.85rem; color:var(--danger); font-weight:700;">
          ⚠️ 検査を開始するには、先に作業者IDを登録してください。
        </p>

        <div style="display:flex; gap:8px;">
          <input type="text" id="txtModalWorkerInput" placeholder="作業者IDを手入力 または 外付けリーダーで読取" style="flex:1;" autocomplete="off">
          <button type="button" class="btn btn-primary" onclick="submitModalWorkerInput()">登録して進む</button>
        </div>

        <div style="display:flex; gap:8px;">
          <button type="button" class="btn btn-success" id="btnStartWorkerQrCam" style="flex:1;" onclick="startWorkerQrCamera()">📷 カメラで作業者QR / バーコードを読取</button>
          <button type="button" class="btn btn-danger" id="btnStopWorkerQrCam" style="display:none;" onclick="stopWorkerQrCamera()">⏹ カメラ停止</button>
        </div>

        <div id="workerQrCamBox" style="position:relative; display:none; width:100%; max-width:380px; margin:0 auto; aspect-ratio:4/3; background:#000; border-radius:8px; overflow:hidden;">
          <div id="workerQrReader" style="width:100%; height:100%;"></div>
          <div class="custom-qr-guide-overlay">
            <span>画面内にQRコードをかざしてください</span>
          </div>
        </div>

        <div style="display:flex; justify-content:flex-end; margin-top:4px;">
          <button type="button" class="btn" onclick="closeWorkerQrModal()">閉じる</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const modalInp = document.getElementById('txtModalWorkerInput');
    modalInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitModalWorkerInput();
      }
    });
  }
}

async function openWorkerQrModal(autoStartCam = true, nextTargetPage = null) {
  blurActiveInput();
  injectWorkerModalUI();
  pendingNavigatePageAfterWorker = nextTargetPage;
  const notice = document.getElementById('workerModalNotice');
  if (notice) {
    notice.style.display = nextTargetPage ? 'block' : 'none';
  }
  document.getElementById('workerAuthModal').style.display = 'flex';
  if (autoStartCam) {
    await startWorkerQrCamera();
  }
}

async function closeWorkerQrModal() {
  await stopWorkerQrCamera();
  const modal = document.getElementById('workerAuthModal');
  if (modal) modal.style.display = 'none';
  pendingNavigatePageAfterWorker = null;
}

async function submitModalWorkerInput() {
  blurActiveInput();
  const val = document.getElementById('txtModalWorkerInput')?.value.trim();
  if (!val) return alert('作業者IDを入力するか、QRコードを読み取ってください');
  await completeWorkerModalRegistration(val);
}

async function completeWorkerModalRegistration(workerCode) {
  const next = pendingNavigatePageAfterWorker;
  await closeWorkerQrModal();
  if (setWorkerRegisteredValue(workerCode)) {
    speakText('作業者を登録しました');
    if (next && typeof navigateTo === 'function') {
      await navigateTo(next);
    }
  }
}

// ★ 対策③：qrboxの固定切り抜き指定を廃止し、カメラ画面のどこに映ってもズレなく認識させる ★
async function startWorkerQrCamera() {
  blurActiveInput();
  await stopWorkerQrCamera();
  isWorkerQrLocked = false;

  const box = document.getElementById('workerQrCamBox');
  const stopBtn = document.getElementById('btnStopWorkerQrCam');
  if (box) box.style.display = 'block';
  if (stopBtn) stopBtn.style.display = 'inline-flex';

  workerQrScanner = new Html5Qrcode('workerQrReader');
  workerQrScanner.start(
    { facingMode: 'environment' },
    { fps: 15 },
    (decodedText) => {
      if (isWorkerQrLocked) return;
      const cleaned = String(decodedText || '').normalize('NFKC').trim();
      if (!cleaned) return;
      isWorkerQrLocked = true;
      completeWorkerModalRegistration(cleaned);
    },
    () => {}
  ).catch(err => {
    alert('作業者QR読取カメラの起動に失敗しました: ' + err);
    stopWorkerQrCamera();
  });
}

async function stopWorkerQrCamera() {
  if (workerQrScanner) {
    try {
      if (workerQrScanner.isScanning) await workerQrScanner.stop();
      await workerQrScanner.clear();
    } catch (e) {}
    workerQrScanner = null;
  }
  const box = document.getElementById('workerQrCamBox');
  const stopBtn = document.getElementById('btnStopWorkerQrCam');
  if (box) box.style.display = 'none';
  if (stopBtn) stopBtn.style.display = 'none';
}

// =========================================================
// ⚙️ 管理画面への拡張設定UI自動挿入
// =========================================================
function injectCustomAdminSettingsUI() {
  const numQrStart = document.getElementById('numQrStart');
  if (!numQrStart) return;
  const card = numQrStart.closest('.card');
  if (!card) return;

  const titleEl = card.querySelector('.card-title');
  if (titleEl) {
    titleEl.textContent = '③ システム共通・読取ルール設定（QR桁数 ／ 大文字・小文字 ／ Oと0・1とI区別 ／ OCR初期値）';
  }

  if (!document.getElementById('ignoreCaseSettingRow')) {
    const caseRow = document.createElement('div');
    caseRow.id = 'ignoreCaseSettingRow';
    caseRow.style.cssText = 'margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;';
    caseRow.innerHTML = `
      <div>
        <strong style="font-size:0.9rem; color:var(--primary-dark);">🔤 アルファベットの大文字・小文字の判定</strong>
        <div style="font-size:0.78rem; color:var(--muted);">ONにすると、バーコードや品番の「abc」と「ABC」を同じ文字として合格判定します</div>
      </div>
      <button type="button" class="btn" id="btnToggleIgnoreCase" onclick="toggleIgnoreCaseSetting()" style="min-width: 260px;"></button>
    `;
    card.appendChild(caseRow);
  }

  if (!document.getElementById('ignoreOZeroSettingRow')) {
    const ozeroRow = document.createElement('div');
    ozeroRow.id = 'ignoreOZeroSettingRow';
    ozeroRow.style.cssText = 'margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;';
    ozeroRow.innerHTML = `
      <div>
        <strong style="font-size:0.9rem; color:var(--primary-dark);">🔄 OCR読取時の「O（オー）」と「0（ゼロ）」の区別</strong>
        <div style="font-size:0.78rem; color:var(--muted);">ONにすると、OCRで英字の「O」と数字の「0」が入れ替わって認識されても同じ品番として判定します</div>
      </div>
      <button type="button" class="btn" id="btnToggleIgnoreOZero" onclick="toggleIgnoreOZeroSetting()" style="min-width: 260px;"></button>
    `;
    card.appendChild(ozeroRow);
  }

  if (!document.getElementById('ignoreOneISettingRow')) {
    const oneIRow = document.createElement('div');
    oneIRow.id = 'ignoreOneISettingRow';
    oneIRow.style.cssText = 'margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;';
    oneIRow.innerHTML = `
      <div>
        <strong style="font-size:0.9rem; color:var(--primary-dark);">🔄 OCR読取時の「1（数字）」と「I（アイ）/ l（エル）」の区別</strong>
        <div style="font-size:0.78rem; color:var(--muted);">ONにすると、OCRで数字の「1」と英字の「I」「l」が入れ替わって認識されても同じ品番として判定します</div>
      </div>
      <button type="button" class="btn" id="btnToggleIgnoreOneI" onclick="toggleIgnoreOneISetting()" style="min-width: 260px;"></button>
    `;
    card.appendChild(oneIRow);
  }

  if (!document.getElementById('ocrDefaultSettingRow')) {
    const ocrRow = document.createElement('div');
    ocrRow.id = 'ocrDefaultSettingRow';
    ocrRow.style.cssText = 'margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border); display: flex; flex-direction: column; gap: 8px;';
    ocrRow.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
        <div>
          <strong style="font-size:0.9rem; color:var(--primary-dark);">🔤 文字(OCR)読取の初期値設定（枠サイズ・影除去感度）</strong>
          <div style="font-size:0.78rem; color:var(--muted);">品番OCRカメラを起動した時に最初からセットされる検査枠の幅・高さ・影除去感度を設定します</div>
        </div>
        <div style="display:flex; gap:6px;">
          <button type="button" class="btn btn-primary" onclick="saveOcrDefaultConfig()">OCR初期値を保存</button>
          <button type="button" class="btn" onclick="resetOcrDefaultConfig()">標準に戻す</button>
        </div>
      </div>

      <div class="voice-grid" style="background:#f8fafc; border:1px solid var(--border); border-radius:8px; padding:10px; margin-top:2px;">
        <div class="slider-row">
          <label style="width:175px;">📏 初期・枠の横幅 (<span id="lblAdminOcrW">75</span>%):</label>
          <input type="range" id="rngAdminOcrW" min="25" max="95" step="1" value="75" oninput="document.getElementById('lblAdminOcrW').textContent=this.value">
        </div>
        <div class="slider-row">
          <label style="width:175px;">↕️ 初期・枠の高さ (<span id="lblAdminOcrH">14</span>%):</label>
          <input type="range" id="rngAdminOcrH" min="8" max="35" step="1" value="14" oninput="document.getElementById('lblAdminOcrH').textContent=this.value">
        </div>
        <div class="slider-row">
          <label style="width:175px;">☀️ 初期・影除去感度 (<span id="lblAdminOcrShadow">14</span>):</label>
          <input type="range" id="rngAdminOcrShadow" min="5" max="35" step="1" value="14" oninput="document.getElementById('lblAdminOcrShadow').textContent=this.value">
        </div>
      </div>
    `;
    card.appendChild(ocrRow);
  }

  updateIgnoreCaseUI();
  updateIgnoreOZeroUI();
  updateIgnoreOneIUI();
  applyOcrDefaultToUI();
}

function updateIgnoreCaseUI() {
  const btn = document.getElementById('btnToggleIgnoreCase');
  if (!btn) return;
  if (isIgnoreCase) {
    btn.className = 'btn btn-success';
    btn.textContent = '✅ 大文字・小文字を無視: ON (同一視)';
  } else {
    btn.className = 'btn btn-dark';
    btn.textContent = '❌ 大文字・小文字を無視: OFF (厳密に区別)';
  }
}

function toggleIgnoreCaseSetting() {
  blurActiveInput();
  isIgnoreCase = !isIgnoreCase;
  localStorage.setItem(CASE_CONFIG_KEY, JSON.stringify(isIgnoreCase));
  saveAudioSettings();
  updateIgnoreCaseUI();
}

function updateIgnoreOZeroUI() {
  const btn = document.getElementById('btnToggleIgnoreOZero');
  if (!btn) return;
  if (isIgnoreOandZero) {
    btn.className = 'btn btn-success';
    btn.textContent = '✅ O(オー)と0(ゼロ)を無視: ON (同一視)';
  } else {
    btn.className = 'btn btn-dark';
    btn.textContent = '❌ O(オー)と0(ゼロ)を無視: OFF (厳密に区別)';
  }
}

function toggleIgnoreOZeroSetting() {
  blurActiveInput();
  isIgnoreOandZero = !isIgnoreOandZero;
  localStorage.setItem(OZERO_CONFIG_KEY, JSON.stringify(isIgnoreOandZero));
  saveAudioSettings();
  updateIgnoreOZeroUI();
}

function updateIgnoreOneIUI() {
  const btn = document.getElementById('btnToggleIgnoreOneI');
  if (!btn) return;
  if (isIgnoreOneAndI) {
    btn.className = 'btn btn-success';
    btn.textContent = '✅ 1(数字)とI(アイ)を無視: ON (同一視)';
  } else {
    btn.className = 'btn btn-dark';
    btn.textContent = '❌ 1(数字)とI(アイ)を無視: OFF (厳密に区別)';
  }
}

function toggleIgnoreOneISetting() {
  blurActiveInput();
  isIgnoreOneAndI = !isIgnoreOneAndI;
  localStorage.setItem(ONE_I_CONFIG_KEY, JSON.stringify(isIgnoreOneAndI));
  saveAudioSettings();
  updateIgnoreOneIUI();
}

function applyOcrDefaultToUI() {
  const w = ocrDefaultConfig.width ?? 75;
  const h = ocrDefaultConfig.height ?? 14;
  const s = ocrDefaultConfig.shadow ?? 14;

  const aW = document.getElementById('rngAdminOcrW');
  const aH = document.getElementById('rngAdminOcrH');
  const aS = document.getElementById('rngAdminOcrShadow');
  if (aW) { aW.value = w; document.getElementById('lblAdminOcrW').textContent = w; }
  if (aH) { aH.value = h; document.getElementById('lblAdminOcrH').textContent = h; }
  if (aS) { aS.value = s; document.getElementById('lblAdminOcrShadow').textContent = s; }

  const wW = document.getElementById('rngOcrW');
  const wH = document.getElementById('rngOcrH');
  const wS = document.getElementById('rngOcrShadow');
  if (wW) { wW.value = w; document.getElementById('lblOcrW').textContent = w; }
  if (wH) { wH.value = h; document.getElementById('lblOcrH').textContent = h; }
  if (wS) { wS.value = s; document.getElementById('lblOcrShadow').textContent = s; }

  const guide = document.getElementById('ocrRoiGuide');
  if (guide) {
    guide.style.width = w + '%';
    guide.style.height = h + '%';
  }
}

function saveOcrDefaultConfig() {
  blurActiveInput();
  const w = parseInt(document.getElementById('rngAdminOcrW')?.value, 10) || 75;
  const h = parseInt(document.getElementById('rngAdminOcrH')?.value, 10) || 14;
  const s = parseInt(document.getElementById('rngAdminOcrShadow')?.value, 10) || 14;

  ocrDefaultConfig = { width: w, height: h, shadow: s };
  localStorage.setItem(OCR_CONFIG_KEY, JSON.stringify(ocrDefaultConfig));
  saveAudioSettings();
  applyOcrDefaultToUI();
  alert(`OCR初期値を保存しました。\n・枠の横幅: ${w}%\n・枠の高さ: ${h}%\n・影除去感度: ${s}`);
}

function resetOcrDefaultConfig() {
  blurActiveInput();
  ocrDefaultConfig = { width: 75, height: 14, shadow: 14 };
  localStorage.setItem(OCR_CONFIG_KEY, JSON.stringify(ocrDefaultConfig));
  saveAudioSettings();
  applyOcrDefaultToUI();
  alert('OCR初期値を標準（横幅:75% / 高さ:14% / 影除去感度:14）に戻しました。');
}

function hookPartOcrScannerStart() {
  if (typeof window.startPartOcrScanner === 'function' && !window._isOcrStartHooked) {
    const origStart = window.startPartOcrScanner;
    window.startPartOcrScanner = async function(...args) {
      applyOcrDefaultToUI();
      return await origStart.apply(this, args);
    };
    window._isOcrStartHooked = true;
  }
}

async function loadSavedConfigs() {
  try {
    csvTableA = (await idbGet(TABLE_A_KEY)) || {};
    csvTableB = (await idbGet(TABLE_B_KEY)) || {};

    qrRangeConfig = JSON.parse(localStorage.getItem(QR_CONFIG_KEY) || '{"start":null,"end":null}');
    if (qrRangeConfig.start) document.getElementById('numQrStart').value = qrRangeConfig.start;
    if (qrRangeConfig.end) document.getElementById('numQrEnd').value = qrRangeConfig.end;

    const savedCase = localStorage.getItem(CASE_CONFIG_KEY);
    if (savedCase !== null) isIgnoreCase = JSON.parse(savedCase);

    const savedOZero = localStorage.getItem(OZERO_CONFIG_KEY);
    if (savedOZero !== null) isIgnoreOandZero = JSON.parse(savedOZero);

    const savedOneI = localStorage.getItem(ONE_I_CONFIG_KEY);
    if (savedOneI !== null) isIgnoreOneAndI = JSON.parse(savedOneI);

    const savedOcr = JSON.parse(localStorage.getItem(OCR_CONFIG_KEY) || 'null');
    if (savedOcr) ocrDefaultConfig = Object.assign(ocrDefaultConfig, savedOcr);

    const savedAudio = JSON.parse(localStorage.getItem(AUDIO_CONFIG_KEY) || 'null');
    if (savedAudio) audioConfig = Object.assign(audioConfig, savedAudio);

    if (audioConfig.ignoreCase !== undefined && savedCase === null) isIgnoreCase = audioConfig.ignoreCase;
    if (audioConfig.ignoreOandZero !== undefined && savedOZero === null) isIgnoreOandZero = audioConfig.ignoreOandZero;
    if (audioConfig.ignoreOneAndI !== undefined && savedOneI === null) isIgnoreOneAndI = audioConfig.ignoreOneAndI;
    if (audioConfig.ocrDefaultConfig && !savedOcr) ocrDefaultConfig = Object.assign(ocrDefaultConfig, audioConfig.ocrDefaultConfig);

    applyAudioConfigToUI();
  } catch (e) {
    console.error('Config load failed:', e);
  }
  injectWorkerModalUI();
  injectCustomAdminSettingsUI();
  hookPartOcrScannerStart();
  initSpeechVoices();
}

// 音声・ブザー制御
function initSpeechVoices() {
  if (!('speechSynthesis' in window)) return;
  const populate = () => {
    const all = window.speechSynthesis.getVoices() || [];
    const jaVoices = all.filter(v => v.lang && (v.lang.includes('ja') || v.lang.includes('JP')));
    const otherVoices = all.filter(v => !v.lang || (!v.lang.includes('ja') && !v.lang.includes('JP')));
    availableVoices = [...jaVoices, ...otherVoices];

    const sel = document.getElementById('selVoiceURI');
    if (!sel) return;
    sel.innerHTML = '<option value="">標準（端末デフォルト日本語音声）</option>' +
      availableVoices.map(v => `<option value="${v.voiceURI}">${v.name} (${v.lang})</option>`).join('');

    if (audioConfig.voiceURI) {
      sel.value = audioConfig.voiceURI;
    }
  };
  populate();
  window.speechSynthesis.onvoiceschanged = populate;
}

function applyAudioConfigToUI() {
  const rRate = document.getElementById('rngVoiceRate');
  const rPitch = document.getElementById('rngVoicePitch');
  const rVol = document.getElementById('rngVoiceVol');
  const sBuz = document.getElementById('selBuzzerPreset');
  if (rRate) { rRate.value = audioConfig.rate; document.getElementById('lblVoiceRate').textContent = audioConfig.rate; }
  if (rPitch) { rPitch.value = audioConfig.pitch; document.getElementById('lblVoicePitch').textContent = audioConfig.pitch; }
  if (rVol) { rVol.value = Math.round(audioConfig.volume * 100); document.getElementById('lblVoiceVol').textContent = Math.round(audioConfig.volume * 100); }
  if (sBuz) { sBuz.value = audioConfig.buzzerPreset || 'STANDARD'; }

  if (audioConfig.ocrDefaultConfig) {
    ocrDefaultConfig = Object.assign(ocrDefaultConfig, audioConfig.ocrDefaultConfig);
    localStorage.setItem(OCR_CONFIG_KEY, JSON.stringify(ocrDefaultConfig));
    applyOcrDefaultToUI();
  }
  if (audioConfig.ignoreCase !== undefined) {
    isIgnoreCase = audioConfig.ignoreCase;
    localStorage.setItem(CASE_CONFIG_KEY, JSON.stringify(isIgnoreCase));
    updateIgnoreCaseUI();
  }
  if (audioConfig.ignoreOandZero !== undefined) {
    isIgnoreOandZero = audioConfig.ignoreOandZero;
    localStorage.setItem(OZERO_CONFIG_KEY, JSON.stringify(isIgnoreOandZero));
    updateIgnoreOZeroUI();
  }
  if (audioConfig.ignoreOneAndI !== undefined) {
    isIgnoreOneAndI = audioConfig.ignoreOneAndI;
    localStorage.setItem(ONE_I_CONFIG_KEY, JSON.stringify(isIgnoreOneAndI));
    updateIgnoreOneIUI();
  }
}

function onAudioSliderChange() {
  const rate = parseFloat(document.getElementById('rngVoiceRate').value) || 1.15;
  const pitch = parseFloat(document.getElementById('rngVoicePitch').value) || 1.0;
  const volPct = parseInt(document.getElementById('rngVoiceVol').value, 10) || 100;
  document.getElementById('lblVoiceRate').textContent = rate.toFixed(2);
  document.getElementById('lblVoicePitch').textContent = pitch.toFixed(2);
  document.getElementById('lblVoiceVol').textContent = volPct;
  saveAudioSettings();
}

function saveAudioSettings() {
  audioConfig.voiceURI = document.getElementById('selVoiceURI')?.value || '';
  audioConfig.rate = parseFloat(document.getElementById('rngVoiceRate')?.value) || 1.15;
  audioConfig.pitch = parseFloat(document.getElementById('rngVoicePitch')?.value) || 1.0;
  audioConfig.volume = (parseInt(document.getElementById('rngVoiceVol')?.value, 10) || 100) / 100;
  audioConfig.buzzerPreset = document.getElementById('selBuzzerPreset')?.value || 'STANDARD';
  audioConfig.ocrDefaultConfig = ocrDefaultConfig;
  audioConfig.ignoreCase = isIgnoreCase;
  audioConfig.ignoreOandZero = isIgnoreOandZero;
  audioConfig.ignoreOneAndI = isIgnoreOneAndI;
  localStorage.setItem(AUDIO_CONFIG_KEY, JSON.stringify(audioConfig));
}

function speakText(text) {
  if (!isSpeechEnabled || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const uttr = new SpeechSynthesisUtterance(text);
    uttr.lang = 'ja-JP';
    uttr.rate = audioConfig.rate || 1.15;
    uttr.pitch = audioConfig.pitch || 1.0;
    uttr.volume = audioConfig.volume ?? 1.0;

    if (audioConfig.voiceURI && availableVoices.length > 0) {
      const matched = availableVoices.find(v => v.voiceURI === audioConfig.voiceURI);
      if (matched) uttr.voice = matched;
    }
    window.speechSynthesis.speak(uttr);
  } catch (e) {}
}

function toggleSpeech() {
  isSpeechEnabled = !isSpeechEnabled;
  document.getElementById('btnSpeechToggle').textContent = isSpeechEnabled ? '🔊 音声: ON' : '🔇 音声: OFF';
}

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playTone(freq, dur, type = 'sine', delayMs = 0) {
  if (audioConfig.buzzerPreset === 'MUTE') return;
  setTimeout(() => {
    try {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.value = (audioConfig.volume ?? 1.0) * 0.35;
      osc.connect(g);
      g.connect(audioCtx.destination);
      osc.start();
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
      osc.stop(audioCtx.currentTime + dur);
    } catch (e) {}
  }, delayMs);
}

function playBuzzerPattern(kind) {
  const preset = audioConfig.buzzerPreset || 'STANDARD';
  if (preset === 'MUTE') return;

  if (kind === 'OK' || kind === 'COMPLETE') {
    if (preset === 'CHIME') {
      playTone(659.25, 0.16, 'sine', 0);
      playTone(523.25, 0.28, 'sine', 150);
    } else if (preset === 'DOUBLE') {
      playTone(1500, 0.08, 'sine', 0);
      playTone(1500, 0.10, 'sine', 100);
    } else {
      playTone(1400, 0.14, 'sine', 0);
    }
  } else {
    if (preset === 'CHIME') {
      playTone(240, 0.22, 'sawtooth', 0);
      playTone(200, 0.35, 'sawtooth', 220);
    } else if (preset === 'DOUBLE') {
      playTone(320, 0.12, 'square', 0);
      playTone(320, 0.12, 'square', 140);
      playTone(320, 0.22, 'square', 280);
    } else {
      playTone(280, 0.45, 'square', 0);
    }
  }
}

function testVoiceAndBuzzer(type) {
  blurActiveInput();
  if (type === 'OK') {
    playBuzzerPattern('OK');
    speakText('ステップ1合格、次は内箱のコードを読み取ってください');
  } else {
    playBuzzerPattern('NG');
    speakText('検査NG、外箱のコードを確認してください');
  }
}

function applyQrSubstring(rawStr, isQrFormat) {
  const norm = normalizeCodeString(rawStr);
  if (!isQrFormat) return norm;
  const s = qrRangeConfig.start ? parseInt(qrRangeConfig.start, 10) : null;
  const e = qrRangeConfig.end ? parseInt(qrRangeConfig.end, 10) : null;
  if (!s && !e) return norm;
  const startIdx = (s && s >= 1) ? (s - 1) : 0;
  const endIdx = (e && e >= 1) ? e : norm.length;
  if (startIdx >= norm.length) return norm;
  return norm.substring(startIdx, endIdx);
}

function saveQrRangeConfig() {
  blurActiveInput();
  const s = parseInt(document.getElementById('numQrStart').value, 10);
  const e = parseInt(document.getElementById('numQrEnd').value, 10);
  qrRangeConfig = {
    start: (!isNaN(s) && s >= 1) ? s : null,
    end: (!isNaN(e) && e >= 1) ? e : null
  };
  localStorage.setItem(QR_CONFIG_KEY, JSON.stringify(qrRangeConfig));
  alert(`QRコード読取範囲を保存しました（開始: ${qrRangeConfig.start || '先頭'} 〜 終了: ${qrRangeConfig.end || '末尾'}）`);
}

function resetQrRangeConfig() {
  blurActiveInput();
  qrRangeConfig = { start: null, end: null };
  document.getElementById('numQrStart').value = '';
  document.getElementById('numQrEnd').value = '';
  localStorage.setItem(QR_CONFIG_KEY, JSON.stringify(qrRangeConfig));
  alert('QRコードの桁数設定を解除しました（全桁読取）。');
}

async function toggleTorch() {
  const stream = camStream || window.partOcrStream;
  if (!stream) return alert('カメラ起動中に使用できます');
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  try {
    isTorchOn = !isTorchOn;
    await track.applyConstraints({ advanced: [{ torch: isTorchOn }] });
  } catch (e) {
    alert('この端末・ブラウザは背面ライト制御に対応していません');
  }
}

function triggerBorderFlash(type) {
  const el = document.getElementById('borderFlash');
  el.className = type === 'OK' ? 'flash-ok' : 'flash-ng';
  setTimeout(() => { el.className = ''; }, 450);
}

function updateCounterUI() {
  document.getElementById('cntOkVal').textContent = countOK;
  document.getElementById('cntNgVal').textContent = countNG;
  const total = countOK + countNG;
  document.getElementById('cntRateVal').textContent = total > 0 ? Math.round((countOK / total) * 100) + '%' : '0%';
}

function recordInspectionLog(partNo, result, note) {
  const worker = document.getElementById('lblWorker').textContent;
  const logs = JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) || '[]');
  logs.unshift({
    date: new Date().toLocaleString('ja-JP'),
    worker,
    partNo: partNo || '未選択',
    result,
    note
  });
  localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(logs.slice(0, 1000)));
}

function exportLogsCSV() {
  const logs = JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) || '[]');
  if (logs.length === 0) return alert('出力する検査ログがありません');
  let csv = '日時,担当者,品番,判定,詳細\r\n';
  logs.forEach(l => {
    csv += `"${l.date}","${l.worker}","${l.partNo}","${l.result}","${l.note}"\r\n`;
  });
  const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Inspection_Log_${Date.now()}.csv`;
  a.click();
}
