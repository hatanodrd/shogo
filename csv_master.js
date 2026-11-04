// =========================================================
// csv_master.js : Aの表・Bの表 CSV解析・自動突合・リセット処理
// =========================================================
function parseCsvLine(line) {
  const res = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      res.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  res.push(cur.trim());
  return res;
}

function handleCsvFileSelect(event, tableType) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const buf = e.target.result;
    let text = '';
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (err) {
      text = new TextDecoder('shift-jis').decode(buf);
    }
    if (tableType === 'A') {
      parseTableACsvText(text);
    } else {
      parseTableBCsvText(text);
    }
    processMasterCsvTables();
  };
  reader.readAsArrayBuffer(file);
}

// Aの表：1行目見出しスキップ、A列(0)=品番、F列(5)=バーコード値
function parseTableACsvText(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const mapA = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCsvLine(line);
    const partNo = normalizeCodeString(cols[0] || '');
    const codeVal = normalizeCodeString(cols.length >= 6 ? cols[5] : (cols[1] || ''));
    if (!partNo || !codeVal) continue;
    if (!mapA[partNo]) mapA[partNo] = [];
    mapA[partNo].push(codeVal);
  }
  csvTableA = mapA;
  localStorage.setItem(TABLE_A_KEY, JSON.stringify(csvTableA));
}

// Bの表：1行目見出しスキップ、A列(0)=品番、B列(1)=外箱、C列(2)=内箱、D列(3)=小箱
function parseTableBCsvText(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const mapB = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCsvLine(line);
    const partNo = normalizeCodeString(cols[0] || '');
    if (!partNo) continue;
    mapB[partNo] = {
      outerRef: normalizeCodeString(cols[1] || ''),
      innerRef: normalizeCodeString(cols[2] || ''),
      smallRef: normalizeCodeString(cols[3] || '')
    };
  }
  csvTableB = mapB;
  localStorage.setItem(TABLE_B_KEY, JSON.stringify(csvTableB));
}

// Aの表とBの表を突合して各品番の照合ステップを生成
function processMasterCsvTables() {
  const storedProfiles = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  const allParts = new Set([
    ...Object.keys(csvTableA),
    ...Object.keys(csvTableB)
  ]);

  let updatedCount = 0;

  allParts.forEach(partNo => {
    const rawCodes = csvTableA[partNo] || [];
    // Aの表は下の行から「外箱 ➔ 内箱 ➔ 小箱」の順なので反転させる
    const codesFromBottom = rawCodes.slice().reverse();
    const bInfo = csvTableB[partNo];

    let csvSteps = [];

    if (bInfo) {
      const activeBoxes = [
        { name: '外箱', ref: bInfo.outerRef },
        { name: '内箱', ref: bInfo.innerRef },
        { name: '小箱', ref: bInfo.smallRef }
      ].filter(b => b.ref !== '');

      if (activeBoxes.length > 0 && codesFromBottom.length > 0) {
        const uniqueRefs = [];
        activeBoxes.forEach(b => {
          if (!uniqueRefs.includes(b.ref)) uniqueRefs.push(b.ref);
        });

        if (codesFromBottom.length === activeBoxes.length) {
          csvSteps = activeBoxes.map((b, idx) => buildCsvStepObj(b.name, codesFromBottom[idx], b.ref));
        } else if (codesFromBottom.length === uniqueRefs.length) {
          const refCodeMap = {};
          uniqueRefs.forEach((rStr, idx) => { refCodeMap[rStr] = codesFromBottom[idx]; });
          csvSteps = activeBoxes.map(b => buildCsvStepObj(b.name, refCodeMap[b.ref], b.ref));
        } else if (codesFromBottom.length === 1) {
          csvSteps = activeBoxes.map(b => buildCsvStepObj(b.name, codesFromBottom[0], b.ref));
        } else {
          csvSteps = activeBoxes.map((b, idx) =>
            buildCsvStepObj(b.name, codesFromBottom[Math.min(idx, codesFromBottom.length - 1)], b.ref)
          );
        }
      }
    } else if (codesFromBottom.length > 0) {
      const codes = codesFromBottom.slice(0, 3);
      csvSteps = codes.map((c, idx) => buildCsvStepObj(BOX_NAMES[idx] || `コード ${idx + 1}`, c, ''));
    }

    const existingSteps = (storedProfiles[partNo] && storedProfiles[partNo].stepsData)
      ? storedProfiles[partNo].stepsData : [];
    const customSteps = existingSteps.filter(s => !s.fromCsv);

    if (csvSteps.length > 0 || customSteps.length > 0) {
      storedProfiles[partNo] = {
        stepsData: [...csvSteps, ...customSteps]
      };
      updatedCount++;
    }
  });

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(storedProfiles));
    updateProfileDropdowns();
    const firstPart = Array.from(allParts)[0];
    if (firstPart && storedProfiles[firstPart]) {
      loadAdminProfile(firstPart);
    }
    alert(`CSV連携更新完了！\n・連携品番数: ${updatedCount} 件\n・Aの表(${Object.keys(csvTableA).length}件) × Bの表(${Object.keys(csvTableB).length}件) から照合回数を自動設定しました。`);
  } catch (e) {
    alert('LocalStorageの容量上限に達しました。不要な品番を削除してください。');
  }
}

function buildCsvStepObj(boxName, codeVal, refText) {
  return {
    name: boxName,
    type: 'BARCODE',
    fromCsv: true,
    refName: refText || '',
    isFullFrame: true,
    x: 0, y: 0, w: 640, h: 480,
    baseW: 640, baseH: 480,
    bakerySamples: [],
    bakeryThreshold: 80,
    expectedBarcode: codeVal
  };
}

function resetCsvMasterData() {
  blurActiveInput();
  if (!confirm('読み込んだCSVデータ（Aの表・Bの表）をリセットしますか？')) return;

  const keepCustom = confirm(
    '設定画面で手動追加した「🥐パン屋AI検査」や「📷追加コード」のステップは残しますか？\n\n' +
    '・[OK] ＝ 手動追加したカメラ検査は残し、CSVの箱ステップのみ消去\n' +
    '・[キャンセル] ＝ すべての品番・ステップを完全に初期化'
  );

  csvTableA = {};
  csvTableB = {};
  localStorage.removeItem(TABLE_A_KEY);
  localStorage.removeItem(TABLE_B_KEY);

  const inputA = document.getElementById('fileCsvA');
  const inputB = document.getElementById('fileCsvB');
  if (inputA) inputA.value = '';
  if (inputB) inputB.value = '';

  if (keepCustom) {
    const storedProfiles = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    Object.keys(storedProfiles).forEach(partNo => {
      const customSteps = (storedProfiles[partNo].stepsData || []).filter(s => !s.fromCsv);
      if (customSteps.length > 0) {
        storedProfiles[partNo].stepsData = customSteps;
      } else {
        delete storedProfiles[partNo];
      }
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(storedProfiles));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }

  window.adminActivePart = '';
  window.adminStepsData = [];
  updateProfileDropdowns();
  renderAdminStepsList();
  drawAdminCanvas();
  alert('CSVデータをリセットしました。');
}