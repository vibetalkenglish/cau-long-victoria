const crypto = require('crypto');
const DEFAULT_SPREADSHEET_ID = '1-425z-aI4Im3b_eZ-ky5B47wm1R_zBa5uYdwCrnswM0';

// Lý do không tạo được xác thực (chỉ mô tả, không chứa giá trị khóa)
let authDebug = '';

// 1. CẤU HÌNH XÁC THỰC GOOGLE SHEETS API
function getGoogleAuth() {
  authDebug = 'hasCredentialsJson=' + !!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON +
    ', hasEmail=' + !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL +
    ', hasPrivateKey=' + !!process.env.GOOGLE_PRIVATE_KEY;
  let google;
  try {
    google = require('googleapis').google;
  } catch (e) {
    return null;
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  if (credentialsJson) {
    try {
      const parsed = JSON.parse(credentialsJson);
      return new google.auth.JWT({
        email: parsed.client_email,
        key: parsed.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
    } catch (e) {
      console.error('Lỗi parse GOOGLE_APPLICATION_CREDENTIALS_JSON:', e);
      // Không đưa e.message ra ngoài vì JSON.parse có thể trích một đoạn nội dung khóa
      const raw = credentialsJson.trim();
      authDebug += ', credentialsJsonInvalid=true, length=' + raw.length + ', startsWithBrace=' + raw.startsWith('{') + ', endsWithBrace=' + raw.endsWith('}');
    }
  }

  if (!email || !privateKey) {
    return null;
  }

  // Xử lý xuống dòng cho private key trong Vercel Environment Variables
  if (privateKey.includes('\\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  return new google.auth.JWT({
    email: email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}

// 2. TỰ ĐỘNG TẠO CÁC SHEET NẾU BẢNG TÍNH CHƯA CÓ
async function ensureSheetsExist(sheets, spreadsheetId) {
  const gridSizes = {};
  const requiredSheets = ['Sessions', 'Members', 'Config', 'Prices', 'Payments'];
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const existingTitles = (meta.data.sheets || []).map(s => s.properties?.title);
    (meta.data.sheets || []).forEach(s => {
      gridSizes[s.properties?.title] = s.properties?.gridProperties || {};
    });

    const sheetsToAdd = requiredSheets.filter(title => !existingTitles.includes(title));
    if (sheetsToAdd.length > 0) {
      const requests = sheetsToAdd.map(title => ({
        addSheet: {
          properties: { title: title }
        }
      }));
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests }
      });
      console.log('Đã tự động tạo các sheet còn thiếu:', sheetsToAdd.join(', '));
      sheetsToAdd.forEach(title => { gridSizes[title] = { rowCount: 1000, columnCount: 26 }; });
    }
  } catch (err) {
    console.warn('Cảnh báo khi kiểm tra cấu trúc sheet:', err.message);
  }
  return gridSizes;
}

// Đổi số thứ tự cột (1-based) sang chữ cái A1: 1 -> A, 27 -> AA
function columnLetter(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// So khớp mã PIN admin (lưu trong biến môi trường ADMIN_PIN trên Vercel)
function checkAdminPin(pin) {
  const expected = process.env.ADMIN_PIN;
  if (!expected) return { ok: false, reason: 'Máy chủ chưa cấu hình biến ADMIN_PIN trên Vercel.' };
  const a = crypto.createHash('sha256').update(String(pin || '').trim()).digest();
  const b = crypto.createHash('sha256').update(String(expected).trim()).digest();
  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'Mã PIN admin không đúng.' };
}

// 3. HÀM ĐỌC DỮ LIỆU TỪ GOOGLE SHEETS (SIÊU TỐC QUA BATCH GET)
async function getFromSheets(sheets, spreadsheetId) {
  await ensureSheetsExist(sheets, spreadsheetId);

  const ranges = [
    'Sessions!A:E',
    'Members',
    'Config!A:B',
    'Prices!A:I',
    'Payments'
  ];

  let valueRanges = [];
  try {
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: spreadsheetId,
      ranges: ranges
    });
    valueRanges = res.data.valueRanges || [];
  } catch (err) {
    console.error('Lỗi batchGet sheets:', err.message);
    throw err;
  }

  const sValues = (valueRanges[0] && valueRanges[0].values) || [];
  const mValues = (valueRanges[1] && valueRanges[1].values) || [];
  const cValues = (valueRanges[2] && valueRanges[2].values) || [];
  const pValues = (valueRanges[3] && valueRanges[3].values) || [];
  const payValues = (valueRanges[4] && valueRanges[4].values) || [];

  function parseSafeNumber(val, defaultVal = 0) {
    if (val === undefined || val === null || val === '') return defaultVal;
    if (typeof val === 'number') return isNaN(val) ? defaultVal : val;
    const str = val.toString().trim().replace(/,/g, '.');
    const num = parseFloat(str);
    return isNaN(num) ? defaultVal : num;
  }

  function parseAttendanceVal(val) {
    if (val === true || val === 'true' || val === 'TRUE' || val === 'Yes' || val === 'yes') return true;
    if (val === false || val === 'false' || val === 'FALSE' || val === 'No' || val === 'no' || !val) return false;
    if (typeof val === 'number') {
      if (val <= 0) return false;
      if (val === 1 || val === 100) return true;
      if (val > 1) return val / 100;
      return val;
    }
    if (typeof val === 'string') {
      const isPercent = val.includes('%');
      const num = parseFloat(val.replace('%', '').replace(',', '.').trim());
      if (isNaN(num) || num <= 0) return false;
      // Chuỗi có dấu % luôn là phần trăm ("1%" = 0.01, "100%" = có mặt đủ)
      if (isPercent) return num >= 100 ? true : num / 100;
      if (num === 1 || num === 100) return true;
      if (num > 1) return num / 100;
      return num;
    }
    return false;
  }

  // A. Sessions
  const sessions = [];
  if (sValues.length > 1) {
    for (let i = 1; i < sValues.length; i++) {
      if (!sValues[i][0]) continue;
      sessions.push({
        id: sValues[i][0].toString(),
        date: sValues[i][1] || '',
        shuttles: parseSafeNumber(sValues[i][2], 0),
        unitPrice: parseSafeNumber(sValues[i][3], 0),
        totalCost: parseSafeNumber(sValues[i][4], 0)
      });
    }
  }

  // B. Payments Map (Ma trận đóng tiền theo buổi)
  const paymentsMap = {};
  if (payValues.length > 1) {
    const payHeaders = payValues[0];
    for (let i = 1; i < payValues.length; i++) {
      const mId = payValues[i][0];
      if (!mId) continue;
      const mPay = {};
      for (let j = 2; j < payHeaders.length; j++) {
        const sId = payHeaders[j];
        if (sId) {
          mPay[sId] = parseSafeNumber(payValues[i][j], 0);
        }
      }
      paymentsMap[mId] = mPay;
      paymentsMap[mId.toString()] = mPay;
      paymentsMap[Number(mId)] = mPay;
    }
  }

  // C. Members
  const members = [];
  if (mValues.length > 1) {
    const headers = mValues[0];
    for (let i = 1; i < mValues.length; i++) {
      if (!mValues[i][0] && !mValues[i][1]) continue;
      const att = {};
      for (let j = 3; j < headers.length; j++) {
        att[headers[j]] = parseAttendanceVal(mValues[i][j]);
      }
      const mId = mValues[i][0];
      const memberPayments = paymentsMap[mId] || paymentsMap[mId.toString()] || paymentsMap[Number(mId)] || {};
      members.push({
        id: Number(mId) || mId,
        name: mValues[i][1] ? mValues[i][1].toString() : '',
        paid: parseSafeNumber(mValues[i][2], 0),
        attendance: att,
        payments: memberPayments
      });
    }
  }

  // D. Config (QR)
  const qrInfo = {};
  if (cValues.length > 1) {
    for (let i = 1; i < cValues.length; i++) {
      if (cValues[i][0]) {
        qrInfo[cValues[i][0]] = cValues[i][1] || '';
      }
    }
  }

  // E. Prices (Lô cầu)
  const shuttleBatches = [];
  if (pValues.length > 1) {
    for (let i = 1; i < pValues.length; i++) {
      if (!pValues[i][0]) continue;
      const isNewFormat = (pValues[0].length >= 8 || pValues[0][2] === 'Số Hộp' || pValues[0][4] === 'Tổng Tiền Mua Cầu');
      
      let label, quantity, packPrice, totalPrice, unitPrice, note, valDepleted;
      if (isNewFormat && pValues[i].length >= 8) {
        label = pValues[i][1] || '';
        quantity = parseSafeNumber(pValues[i][2], 1);
        packPrice = parseSafeNumber(pValues[i][3], 0);
        totalPrice = parseSafeNumber(pValues[i][4], quantity * packPrice);
        unitPrice = parseSafeNumber(pValues[i][5], Math.round(packPrice / 12));
        note = pValues[i][6] || '';
        valDepleted = pValues[i][7];
      } else {
        label = pValues[i][1] || '';
        quantity = 1;
        packPrice = parseSafeNumber(pValues[i][2], 0);
        totalPrice = packPrice;
        unitPrice = parseSafeNumber(pValues[i][3], Math.round(packPrice / 12));
        note = pValues[i][4] || '';
        valDepleted = pValues[i][5];
      }

      shuttleBatches.push({
        id: pValues[i][0],
        label: label,
        quantity: quantity,
        packPrice: packPrice,
        totalPrice: totalPrice,
        unitPrice: unitPrice,
        note: note,
        isDepleted: (valDepleted === true || valDepleted === 'true' || valDepleted === 'Hết' || valDepleted === 'Đã hết'),
        // ID thành viên đã trả tiền lô này (cột I, trống = chưa ghi)
        paidBy: (pValues[i][8] === undefined || pValues[i][8] === '') ? '' : (Number(pValues[i][8]) || pValues[i][8])
      });
    }
  }

  // Tự động tính toán tiền đã nộp của Kantan (Chủ Quỹ):
  // Tổng tiền cầu đã mua - Tổng tiền các thành viên khác đã đóng (kể cả đóng dư).
  // Giữ khớp với calculateSheetMath() trong index.html.
  const isKantan = (m) => m && m.name && m.name.trim().toLowerCase() === 'kantan';
  const kantanMember = members.find(m => isKantan(m));
  if (kantanMember) {
    const totalBoughtShuttles = shuttleBatches.reduce((sum, b) => {
      const qty = Number(b.quantity) || 1;
      const pack = Number(b.packPrice) || 0;
      return sum + (Number(b.totalPrice) || (qty * pack));
    }, 0);

    const collectedFromMembers = members.reduce((sum, m) => {
      return isKantan(m) ? sum : sum + (Number(m.paid) || 0);
    }, 0);

    kantanMember.paid = totalBoughtShuttles - collectedFromMembers;
  }

  return { sessions, members, qrInfo, shuttleBatches };
}

// 4. HÀM GHI DỮ LIỆU VÀO GOOGLE SHEETS
// Ghi dữ liệu mới TRƯỚC, sau đó mới dọn phần thừa bên dưới/bên phải.
// Nếu bước ghi lỗi giữa chừng, dữ liệu cũ vẫn còn nguyên thay vì bị xóa trắng.
async function saveToSheets(sheets, spreadsheetId, payload) {
  const gridSizes = await ensureSheetsExist(sheets, spreadsheetId);

  const { sessions, members, qrInfo, shuttleBatches } = payload;

  // A. Chuẩn bị dữ liệu Sessions
  const sData = [['ID', 'Ngày/Thứ', 'Số Cầu', 'Đơn Giá', 'Tổng Tiền (tự nhập)']];
  if (sessions && Array.isArray(sessions)) {
    sessions.forEach(s => sData.push([s.id, s.date, s.shuttles, s.unitPrice, Number(s.totalCost) > 0 ? Number(s.totalCost) : '']));
  }

  // B. Chuẩn bị dữ liệu Members
  const mHeaders = ['ID', 'Tên', 'Đã Thanh Toán'];
  if (sessions && Array.isArray(sessions)) {
    sessions.forEach(s => mHeaders.push(s.id));
  }
  const mData = [mHeaders];
  if (members && Array.isArray(members)) {
    members.forEach(m => {
      const row = [m.id, m.name, m.paid];
      if (sessions && Array.isArray(sessions)) {
        sessions.forEach(s => {
          const a = m.attendance ? m.attendance[s.id] : false;
          if (a === true || a === 1) {
            row.push('Yes');
          } else if (typeof a === 'number' && a > 0) {
            const pct = a > 1 ? Math.round(a) : Math.round(a * 100);
            row.push(pct >= 100 ? 'Yes' : `${pct}%`);
          } else if (typeof a === 'string' && a.includes('%')) {
            row.push(a);
          } else if (a && a !== 'No' && a !== 'false') {
            row.push('Yes');
          } else {
            row.push('No');
          }
        });
      }
      mData.push(row);
    });
  }

  // C. Chuẩn bị dữ liệu Config
  // Ô Google Sheets chứa tối đa 50.000 ký tự. Ảnh QR quá lớn thì giữ nguyên ảnh cũ trên Sheet
  // (không ghi dòng qrUrl) thay vì cắt cụt làm hỏng ảnh.
  const rawQrUrl = (qrInfo && qrInfo.qrUrl) ? qrInfo.qrUrl : '';
  const qrTooLarge = rawQrUrl.length > 49000;
  const cData = [
    ['Key', 'Value'],
    ['bankName', (qrInfo && qrInfo.bankName) ? qrInfo.bankName : ''],
    ['bankAcc', (qrInfo && qrInfo.bankAcc) ? qrInfo.bankAcc : ''],
    ['bankOwner', (qrInfo && qrInfo.bankOwner) ? qrInfo.bankOwner : '']
  ];
  // Số liệu đếm cầu đặt SAU dòng qrUrl (dòng 5) để vị trí ảnh QR không đổi
  const stockRows = [
    ['stockCount', qrInfo && qrInfo.stockCount !== undefined ? qrInfo.stockCount : ''],
    ['stockCountExpected', qrInfo && qrInfo.stockCountExpected !== undefined ? qrInfo.stockCountExpected : ''],
    ['stockCountDate', qrInfo && qrInfo.stockCountDate ? qrInfo.stockCountDate : '']
  ];
  if (qrTooLarge) {
    // Giữ nguyên dòng 5 (ảnh QR cũ), chỉ ghi phần trước và sau nó
    cData.length = 4;
  } else {
    cData.push(['qrUrl', rawQrUrl]);
    stockRows.forEach(r => cData.push(r));
  }

  // D. Chuẩn bị dữ liệu Prices
  const pData = [['ID', 'Lần Mua', 'Số Hộp', 'Giá 1 Hộp (12 Trái)', 'Tổng Tiền Mua Cầu', 'Đơn Giá 1 Trái', 'Ghi chú', 'Tình trạng', 'Người trả (ID thành viên)']];
  if (shuttleBatches && Array.isArray(shuttleBatches)) {
    shuttleBatches.forEach(b => {
      const qty = Number(b.quantity) || 1;
      const pack = Number(b.packPrice) || 0;
      const total = Number(b.totalPrice) || (qty * pack);
      const unit = Number(b.unitPrice) || Math.round(pack / 12);
      pData.push([b.id, b.label, qty, pack, total, unit, b.note || '', b.isDepleted ? 'Hết' : 'Còn', b.paidBy === undefined || b.paidBy === null ? '' : b.paidBy]);
    });
  }

  // E. Chuẩn bị dữ liệu Payments
  const payHeaders = ['MemberID', 'MemberName'];
  if (sessions && Array.isArray(sessions)) {
    sessions.forEach(s => payHeaders.push(s.id));
  }
  const payData = [payHeaders];
  if (members && Array.isArray(members)) {
    members.forEach(m => {
      const row = [m.id, m.name];
      if (sessions && Array.isArray(sessions)) {
        sessions.forEach(s => {
          const pVal = (m.payments && m.payments[s.id]) ? Number(m.payments[s.id]) : 0;
          row.push(pVal);
        });
      }
      payData.push(row);
    });
  }

  const blocks = [
    { name: 'Sessions', values: sData },
    { name: 'Members', values: mData },
    { name: 'Config', values: cData, keepRows: qrTooLarge ? 5 + stockRows.length : 0 },
    { name: 'Prices', values: pData },
    { name: 'Payments', values: payData }
  ];

  // 1. Ghi toàn bộ dữ liệu mới (1 request)
  const updateRes = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: blocks.map(b => ({ range: `${b.name}!A1`, values: b.values }))
        .concat(qrTooLarge ? [{ range: 'Config!A6', values: stockRows }] : [])
    }
  });

  // 2. Dọn dữ liệu cũ còn sót bên dưới và bên phải vùng vừa ghi (vd: buổi/thành viên đã xóa)
  const leftovers = [];
  blocks.forEach(b => {
    const grid = gridSizes[b.name] || {};
    const usedRows = Math.max(b.values.length, b.keepRows || 0);
    const usedCols = Math.max(...b.values.map(r => r.length));
    if (grid.rowCount > usedRows) {
      leftovers.push(`${b.name}!${usedRows + 1}:${grid.rowCount}`);
    }
    if (grid.columnCount > usedCols) {
      leftovers.push(`${b.name}!${columnLetter(usedCols + 1)}1:${columnLetter(grid.columnCount)}${usedRows}`);
    }
  });
  if (leftovers.length > 0) {
    try {
      await sheets.spreadsheets.values.batchClear({
        spreadsheetId: spreadsheetId,
        requestBody: { ranges: leftovers }
      });
    } catch (clearErr) {
      console.warn('Cảnh báo dọn dữ liệu thừa:', clearErr.message);
    }
  }

  if (qrTooLarge) {
    updateRes.data.warning = 'Ảnh QR quá lớn (>49.000 ký tự) nên chưa được lưu, ảnh cũ được giữ nguyên.';
  }
  return updateRes.data;
}

// 5. HÀM GỌI GEMINI AI
async function callGeminiAI(promptText, clubContext) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return 'Lỗi: Chưa cấu hình GEMINI_API_KEY trong biến môi trường của Vercel sếp ơi!';
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const systemInstruction = "Bạn là trợ lý AI thông minh, vui vẻ và rất khéo léo dành cho người quản lý CLB Cầu Lông. Xưng là 'tôi' và gọi người dùng là 'Sếp'. Dùng tiếng Việt chuẩn, thêm emoji.";

  const payload = {
    contents: [{
      parts: [{ text: (clubContext ? clubContext + '\n\n' : '') + promptText }]
    }],
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const json = await res.json();
  if (json.candidates && json.candidates[0] && json.candidates[0].content) {
    return json.candidates[0].content.parts[0].text;
  } else if (json.error) {
    return 'Lỗi từ Gemini AI: ' + json.error.message;
  }
  return 'Không nhận được phản hồi từ Gemini AI.';
}

// 6. SERVERLESS HANDLER CHO VERCEL
module.exports = async (req, res) => {
  // Bật CORS cho mọi request
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const auth = getGoogleAuth();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID || DEFAULT_SPREADSHEET_ID;
  const FALLBACK_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxtEZgoalXo5UzktFuw0xBMe_0DZRZIYqBGjrWbYigw_qwlxQHeFQe6UUJLym4EtlVhbg/exec';

  // Nếu chưa cấu hình Service Account trên Vercel: Tự động Proxy ngầm qua Apps Script Web App (Zero Config)
  if (!auth || !spreadsheetId) {
    if (req.method === 'GET') {
      try {
        const response = await fetch(FALLBACK_SCRIPT_URL + '?action=loadData&_t=' + Date.now());
        const data = await response.json();
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        return res.status(200).json(data);
      } catch (proxyErr) {
        console.error('Lỗi fallback proxy GET:', proxyErr);
        return res.status(200).json({
          success: false,
          error: 'Lỗi kết nối proxy tới Google Sheets: ' + proxyErr.message,
          authDebug: authDebug
        });
      }
    }

    if (req.method === 'POST') {
      try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        if (body.action === 'saveData' || body.action === 'verifyPin') {
          const check = checkAdminPin(body.pin);
          if (!check.ok) {
            await new Promise(r => setTimeout(r, 1000));
            return res.status(401).json({ success: false, authError: true, error: check.reason });
          }
          if (body.action === 'verifyPin') return res.status(200).json({ success: true });
        }
        const response = await fetch(FALLBACK_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(body)
        });
        const data = await response.json();
        return res.status(200).json(data);
      } catch (proxyErr) {
        console.error('Lỗi fallback proxy POST:', proxyErr);
        return res.status(500).json({
          success: false,
          error: 'Lỗi ghi dữ liệu qua proxy: ' + proxyErr.message
        });
      }
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { google } = require('googleapis');
  const sheets = google.sheets({ version: 'v4', auth });

  // A. GET /api/data -> Đọc dữ liệu từ Google Sheets
  if (req.method === 'GET') {
    try {
      const data = await getFromSheets(sheets, spreadsheetId);
      // Tắt cache hoàn toàn để đảm bảo dữ liệu luôn mới nhất
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      return res.status(200).json({
        success: true,
        data: data,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      console.error('Lỗi đọc Google Sheets:', err);
      return res.status(500).json({
        success: false,
        error: 'Lỗi đọc dữ liệu từ Google Sheets: ' + err.message
      });
    }
  }

  // B. POST /api/data -> Lưu dữ liệu hoặc Gọi AI
  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const action = body.action;

      if (action === 'verifyPin') {
        const check = checkAdminPin(body.pin);
        if (!check.ok) await new Promise(r => setTimeout(r, 1000)); // làm chậm việc dò PIN
        return res.status(check.ok ? 200 : 401).json({ success: check.ok, error: check.reason });
      }

      if (action === 'saveData') {
        const check = checkAdminPin(body.pin);
        if (!check.ok) {
          await new Promise(r => setTimeout(r, 1000));
          return res.status(401).json({ success: false, authError: true, error: check.reason });
        }
        const payload = body.payload;
        if (!payload || !Array.isArray(payload.sessions) || !Array.isArray(payload.members)) {
          return res.status(400).json({ success: false, error: 'Dữ liệu gửi lên không hợp lệ.' });
        }
        const result = await saveToSheets(sheets, spreadsheetId, payload);
        return res.status(200).json({
          success: true,
          warning: result && result.warning,
          message: 'Đã lưu dữ liệu vào Google Sheets thành công!'
        });
      }

      if (action === 'askGemini') {
        const prompt = body.prompt || '';
        const context = body.context || '';
        const reply = await callGeminiAI(prompt, context);
        return res.status(200).json({
          success: true,
          reply: reply
        });
      }

      return res.status(400).json({
        success: false,
        error: 'Hành động không hợp lệ (Unknown action)'
      });
    } catch (err) {
      console.error('Lỗi lưu Google Sheets:', err);
      return res.status(500).json({
        success: false,
        error: 'Lỗi ghi dữ liệu vào Google Sheets: ' + err.message
      });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
