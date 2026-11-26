// =========================================================
// csv_master.js : Aの表・Bの表 CSV解析・IndexedDB保存・自動突合・リセット処理
// =========================================================

// IndexedDB生データ取得ヘルパー（config_audio.jsのidbGetRaw/idbGetに対応）
async function readMasterStoreRaw(key) {
  if (typeof idbGetRaw === 'function') return await idbGetRaw(key);
  if (typeof idbGet === 'function') return await idbGet(key);
  return JSON.parse(localStorage.getItem(key) || 'null');
}

async function writeMasterStore(key, val) {
  if (typeof idbSet === 'function') {
    await idbSet(key, val);
  } else {
    localStorage.setItem(key, JSON.stringify(val));
  }
}

async function removeMasterStore(key) {
  if (typeof idbDelete === 'function') {
    await idbDelete(key);
  } else {
    localStorage.removeItem(key);
  }
}

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
  blurActiveInput();
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

// Aの表：1行目見出しスキップ、A列(0)=品番、F列(5)=バーコード値（6列未満ならB列(1)）
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
  await writeMasterStore(TABLE_A_KEY, csvTableA);
}

// Bの表：1行目見出しスキップ、A列(0)=品番、B列(1)=外箱、C列(2)=内箱、D列(3)=小箱
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
  await writeMasterStore(TABLE_B_KEY, csvTableB);
}

// Bの表のセル値が「照合対象（有効なラベル参照先）」かどうかを判定
function isValidBoxRef(refStr) {
  const s = normalizeCodeString(refStr || '');
  if (!s) return false;
  const ignoreTokens = ['-', '―', '－', 'ー', 'なし', '無', '不要', '0', 'NONE', 'N/A', 'NA', '×'];
  return !ignoreTokens.includes(s);
}

// Aの表とBの表から品番キーを柔軟に検索（O/0や1/I揺れにも対応）
function findRecordByPartKey(mapObj, partNo) {
  if (!mapObj || !partNo) return null;
  if (mapObj[partNo]) return mapObj[partNo];
  if (typeof unifyAmbiguousCharsKey === 'function') {
    const targetUni = unifyAmbiguousCharsKey(partNo);
    const keys = Object.keys(mapObj);
    for (let i = 0; i < keys.length; i++) {
      if (unifyAmbiguousCharsKey(keys[i]) === targetUni) {
        return mapObj[keys[i]];
      }
    }
  }
  return null;
}

// Aの表とBの表を突合して各品番の照合ステップをIndexedDBへ生成・保存
async function processMasterCsvTables() {
  // メモリ上のcsvTableA/Bが空の場合はIndexedDBから復元
  if (!csvTableA || Object.keys(csvTableA).length === 0) {
    csvTableA = (await readMasterStoreRaw(TABLE_A_KEY)) || {};
  }
  if (!csvTableB || Object.keys(csvTableB).length === 0) {
    csvTableB = (await readMasterStoreRaw(TABLE_B_KEY)) || {};
  }

  const storedProfiles = (await readMasterStoreRaw(STORAGE_KEY)) || {};
  const allParts = new Set([
    ...Object.keys(csvTableA),
    ...Object.keys(csvTableB)
  ]);

  let updatedCount = 0;
  let multiStepCount = 0;

  allParts.forEach(partNo => {
    const rawCodes = findRecordByPartKey(csvTableA, partNo) || [];
    // Aの表は下の行から「外箱 ➔ 内箱 ➔ 小箱」の順なので反転させる
    const codesFromBottom = rawCodes.slice().reverse();
    const bInfo = findRecordByPartKey(csvTableB, partNo);

    let csvSteps = [];

    if (bInfo) {
      // Bの表に該当品番がある場合：有効な箱（外箱・内箱・小箱）の列数ぶんステップを作成
      const activeBoxes = [
        { name: '外箱', ref: bInfo.outerRef },
        { name: '内箱', ref: bInfo.innerRef },
        { name: '小箱', ref: bInfo.smallRef }
      ].filter(b => isValidBoxRef(b.ref));

      if (activeBoxes.length > 0 && codesFromBottom.length > 0) {
        const uniqueRefs = [];
        activeBoxes.forEach(b => {
          if (!uniqueRefs.includes(b.ref)) uniqueRefs.push(b.ref);
        });

        if (codesFromBottom.length === activeBoxes.length) {
          // 例：Bの表で2箱指定 ＆ Aの表も2行ある場合 ➔ それぞれ順に割り当て
          csvSteps = activeBoxes.map((b, idx) => buildCsvStepObj(b.name, codesFromBottom[idx], b.ref));
        } else if (codesFromBottom.length === uniqueRefs.length) {
          // 例：Bの表で2箱指定（参照先名も別）＆ Aの表も同数ある場合
          const refCodeMap = {};
          uniqueRefs.forEach((rStr, idx) => { refCodeMap[rStr] = codesFromBottom[idx]; });
          csvSteps = activeBoxes.map(b => buildCsvStepObj(b.name, refCodeMap[b.ref], b.ref));
        } else if (codesFromBottom.length === 1) {
          // 例：Bの表で「外箱・内箱」の2ステップ指定だが、Aの表は共通JAN1行のみの場合
          // ➔ 同じJANコードで「Step1: 外箱」「Step2: 内箱」の2ステップを生成！
          csvSteps = activeBoxes.map(b => buildCsvStepObj(b.name, codesFromBottom[0], b.ref));
        } else {
          csvSteps = activeBoxes.map((b, idx) =>
            buildCsvStepObj(b.name, codesFromBottom[Math.min(idx, codesFromBottom.length - 1)], b.ref)
          );
        }
      }
    } else if (codesFromBottom.length > 0) {
      // Bの表に未登録の品番はAの表の行数（最大3行：外箱➔内箱➔小箱）から自動生成
      const codes = codesFromBottom.slice(0, 3);
      csvSteps = codes.map((c, idx) => buildCsvStepObj(BOX_NAMES[idx] || `コード ${idx + 1}`, c, ''));
    }

    // 手動追加した「🥐パン屋AI」「🔤OCR文字検査」「📷追加コード」は消さずに後ろへ保持
    const existingSteps = (storedProfiles[partNo] && storedProfiles[partNo].stepsData)
      ? storedProfiles[partNo].stepsData : [];
    const customSteps = existingSteps.filter(s => !s.fromCsv);

    if (csvSteps.length > 0 || customSteps.length > 0) {
      const mergedSteps = [...csvSteps, ...customSteps];
      storedProfiles[partNo] = { stepsData: mergedSteps };
      updatedCount++;
      if (mergedSteps.length >= 2) multiStepCount++;
    }
  });

  try {
    await writeMasterStore(STORAGE_KEY, storedProfiles);
    if (typeof updateProfileDropdowns === 'function') {
      await updateProfileDropdowns(false);
    }
    if (typeof triggerAutoPushToGas === 'function') {
      triggerAutoPushToGas();
    }

    // 現在選択中の品番、または最初の複数ステップ品番をプレビュー表示
    const targetPreviewPart = (window.adminActivePart && storedProfiles[window.adminActivePart])
      ? window.adminActivePart
      : Array.from(allParts).find(p => storedProfiles[p]?.stepsData?.length >= 2) || Array.from(allParts)[0];

    if (targetPreviewPart && storedProfiles[targetPreviewPart] && typeof loadAdminProfile === 'function') {
      await loadAdminProfile(targetPreviewPart);
    }

    alert(
      `CSV連携更新完了！\n` +
      `・連携品番数: ${updatedCount} 件（うち2ステップ以上: ${multiStepCount} 件）\n` +
      `・Aの表: ${Object.keys(csvTableA).length} 品番 ／ Bの表: ${Object.keys(csvTableB).length} 品番\n` +
      `※Bの表の「外箱・内箱・小箱」の指定に基づいて照合ステップを生成しました。`
    );
  } catch (e) {
    alert('データベース保存エラー: ' + e.message);
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
    expectedBarcode: codeVal,
    expectedOcrText: '',
    ocrMatchMode: 'EXACT'
  };
}

async function resetCsvMasterData() {
  blurActiveInput();
  if (!confirm('読み込んだCSVデータ（Aの表・Bの表）をリセットしますか？')) return;

  const keepCustom = confirm(
    '設定画面で手動追加した「🥐パン屋AI検査」や「🔤OCR文字検査」「📷追加コード」のステップは残しますか？\n\n' +
    '・[OK] ＝ 手動追加した検査は残し、CSVの箱ステップのみ消去\n' +
    '・[キャンセル] ＝ すべての品番・ステップを完全に初期化'
  );

  csvTableA = {};
  csvTableB = {};
  await removeMasterStore(TABLE_A_KEY);
  await removeMasterStore(TABLE_B_KEY);

  const inputA = document.getElementById('fileCsvA');
  const inputB = document.getElementById('fileCsvB');
  if (inputA) inputA.value = '';
  if (inputB) inputB.value = '';

  if (keepCustom) {
    const storedProfiles = (await readMasterStoreRaw(STORAGE_KEY)) || {};
    Object.keys(storedProfiles).forEach(partNo => {
      const customSteps = (storedProfiles[partNo].stepsData || []).filter(s => !s.fromCsv);
      if (customSteps.length > 0) {
        storedProfiles[partNo].stepsData = customSteps;
      } else {
        delete storedProfiles[partNo];
      }
    });
    await writeMasterStore(STORAGE_KEY, storedProfiles);
  } else {
    await removeMasterStore(STORAGE_KEY);
  }

  window.adminActivePart = '';
  window.adminStepsData = [];
  if (typeof triggerAutoPushToGas === 'function') triggerAutoPushToGas();
  if (typeof updateProfileDropdowns === 'function') await updateProfileDropdowns(false);
  if (typeof renderAdminStepsList === 'function') renderAdminStepsList();
  if (typeof drawAdminCanvas === 'function') drawAdminCanvas();
  alert('CSVデータをリセットしました。');
}
