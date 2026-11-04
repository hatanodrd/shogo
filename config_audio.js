// =========================================================
// config_audio.js : 定数・グローバル状態・音声＆効果音変更・ログ管理
// =========================================================
const STORAGE_KEY = 'pokayoke_step_profiles_v5';
const TABLE_A_KEY = 'pokayoke_csv_table_a_v5';
const TABLE_B_KEY = 'pokayoke_csv_table_b_v5';
const QR_CONFIG_KEY = 'pokayoke_qr_range_config_v5';
const AUDIO_CONFIG_KEY = 'pokayoke_audio_config_v5';
const LOG_STORAGE_KEY = 'pokayoke_inspection_logs_v5';
const BOX_NAMES = ['外箱', '内箱', '小箱'];

let csvTableA = {};
let csvTableB = {};
let qrRangeConfig = { start: null, end: null };

// 音声・ブザー設定
let isSpeechEnabled = true;
let audioConfig = {
  voiceURI: '',
  rate: 1.15,
  pitch: 1.0,
  volume: 1.0,
  buzzerPreset: 'STANDARD' // STANDARD, CHIME, DOUBLE, MUTE
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

// ソフトキーボード強制クローズ（画面遷移時にキーボードを開かせない）
function blurActiveInput() {
  if (document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    document.activeElement.blur();
  }
}

function normalizeCodeString(str) {
  if (!str) return '';
  return String(str).normalize('NFKC').trim();
}

function loadSavedConfigs() {
  try {
    csvTableA = JSON.parse(localStorage.getItem(TABLE_A_KEY) || '{}');
    csvTableB = JSON.parse(localStorage.getItem(TABLE_B_KEY) || '{}');
    qrRangeConfig = JSON.parse(localStorage.getItem(QR_CONFIG_KEY) || '{"start":null,"end":null}');
    if (qrRangeConfig.start) document.getElementById('numQrStart').value = qrRangeConfig.start;
    if (qrRangeConfig.end) document.getElementById('numQrEnd').value = qrRangeConfig.end;

    const savedAudio = JSON.parse(localStorage.getItem(AUDIO_CONFIG_KEY) || 'null');
    if (savedAudio) {
      audioConfig = Object.assign(audioConfig, savedAudio);
    }
    applyAudioConfigToUI();
  } catch (e) {}
  initSpeechVoices();
}

// =========================================================
// 🔊 音声（話者・速度・高さ・音量）＆ ブザー効果音カスタマイズ
// =========================================================
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

// プリセット対応のOK/NGブザー音再生
function playBuzzerPattern(kind) {
  const preset = audioConfig.buzzerPreset || 'STANDARD';
  if (preset === 'MUTE') return;

  if (kind === 'OK' || kind === 'COMPLETE') {
    if (preset === 'CHIME') {
      playTone(659.25, 0.16, 'sine', 0);   // ミ
      playTone(523.25, 0.28, 'sine', 150); // ド
    } else if (preset === 'DOUBLE') {
      playTone(1500, 0.08, 'sine', 0);
      playTone(1500, 0.10, 'sine', 100);
    } else {
      playTone(1400, 0.14, 'sine', 0);
    }
  } else {
    // NG時
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

// =========================================================
// QRコード専用 桁数切り出し設定
// =========================================================
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

// =========================================================
// 実績カウンター・背面ライト・CSVログ出力
// =========================================================
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

function registerWorker() {
  blurActiveInput();
  const val = document.getElementById('txtWorkerInput').value.trim();
  if (!val) return;
  const lbl = document.getElementById('lblWorker');
  lbl.textContent = val;
  lbl.style.color = 'var(--success)';
  document.getElementById('txtWorkerInput').value = '';
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