// =========================================================
// csv_master.js : Aの表・Bの表 CSV解析・IndexedDB保存・突合処理
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
  reader.onload = async (e) => {
    const buf = e.target.result;
    let text = '';
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (err) {
      text = new TextDecoder('shift-jis').decode(buf);
    }
    if (tableType === 'A') {
      await parseTableACsvText(text);
    } else {
      await parseTableBCsvText(text);
    }
    await processMasterCsvTables();
  };
  reader.readAsArrayBuffer(file);
}

async function parseTableACsvText(text) {
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
  await idbSet(TABLE_A_KEY, csvTableA);
}

async function parseTableBCsvText(text) {
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
  await idbSet(TABLE_B_KEY, csvTableB);
}

async function processMasterCsvTables() {
  const storedProfiles = (await idbGet(STORAGE_KEY)) || {};
  const allParts = new Set([
    ...Object.keys(csvTableA),
    ...Object.keys(csvTableB)
  ]);

  let updatedCount = 0;

  allParts.forEach(partNo => {
    const rawCodes = csvTableA[partNo] || [];
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
    await idbSet(STORAGE_KEY, storedProfiles);
    await updateProfileDropdowns();
    const firstPart = Array.from(allParts)[0];
    if (firstPart && storedProfiles[firstPart]) {
      await loadAdminProfile(firstPart);
    }
    alert(`CSV連携更新完了！\n・連携品番数: ${updatedCount} 件\n・大容量IndexedDBへ正常に保存されました。`);
  } catch (e) {
    alert('保存処理に失敗しました: ' + e.message);
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

async function resetCsvMasterData() {
  blurActiveInput();
  if (!confirm('読み込んだCSVデータ（Aの表・Bの表）をリセットしますか？')) return;

  const keepCustom = confirm(
    '設定画面で手動追加した「🥐パン屋AI検査」や「📷追加コード」のステップは残しますか？\n\n' +
    '・[OK] ＝ 手動追加したカメラ検査は残し、CSVの箱ステップのみ消去\n' +
    '・[キャンセル] ＝ すべての品番・ステップを完全に初期化'
  );

  csvTableA = {};
  csvTableB = {};
  await idbDelete(TABLE_A_KEY);
  await idbDelete(TABLE_B_KEY);

  const inputA = document.getElementById('fileCsvA');
  const inputB = document.getElementById('fileCsvB');
  if (inputA) inputA.value = '';
  if (inputB) inputB.value = '';

  if (keepCustom) {
    const storedProfiles = (await idbGet(STORAGE_KEY)) || {};
    Object.keys(storedProfiles).forEach(partNo => {
      const customSteps = (storedProfiles[partNo].stepsData || []).filter(s => !s.fromCsv);
      if (customSteps.length > 0) {
        storedProfiles[partNo].stepsData = customSteps;
      } else {
        delete storedProfiles[partNo];
      }
    });
    await idbSet(STORAGE_KEY, storedProfiles);
  } else {
    await idbDelete(STORAGE_KEY);
  }

  window.adminActivePart = '';
  window.adminStepsData = [];
  await updateProfileDropdowns();
  renderAdminStepsList();
  drawAdminCanvas();
  alert('CSVデータをリセットしました。');
}
