// 1. CẤU HÌNH XÁC THỰC GOOGLE SHEETS API
function getGoogleAuth() {
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
  const requiredSheets = ['Sessions', 'Members', 'Config', 'Prices', 'Payments'];
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const existingTitles = (meta.data.sheets || []).map(s => s.properties?.title);

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
    }
  } catch (err) {
    console.warn('Cảnh báo khi kiểm tra cấu trúc sheet:', err.message);
  }
}

// 3. HÀM ĐỌC DỮ LIỆU TỪ GOOGLE SHEETS (SIÊU TỐC QUA BATCH GET)
async function getFromSheets(sheets, spreadsheetId) {
  await ensureSheetsExist(sheets, spreadsheetId);

  const ranges = [
    'Sessions!A:D',
    'Members!A:Z',
    'Config!A:B',
    'Prices!A:H',
    'Payments!A:Z'
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

  // A. Sessions
  const sessions = [];
  if (sValues.length > 1) {
    for (let i = 1; i < sValues.length; i++) {
      if (!sValues[i][0]) continue;
      sessions.push({
        id: sValues[i][0].toString(),
        date: sValues[i][1] || '',
        shuttles: parseSafeNumber(sValues[i][2]),
        unitPrice: parseSafeNumber(sValues[i][3])
      });
    }
  }

  // B. Payments Map
  const paymentsMap = {};
  if (payValues.length > 1) {
    const payHeaders = payValues[0];
    for (let i = 1; i < payValues.length; i++) {
      const mId = payValues[i][0];
      if (!mId) continue;
      paymentsMap[mId] = {};
      paymentsMap[mId.toString()] = {};
      for (let j = 2; j < payHeaders.length; j++) {
        const sId = payHeaders[j];
        const val = parseSafeNumber(payValues[i][j]);
        paymentsMap[mId][sId] = val;
        paymentsMap[mId.toString()][sId] = val;
      }
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
        const val = mValues[i][j];
        att[headers[j]] = (val === true || val === 'true' || val === 'TRUE' || val === 'Yes');
      }
      const mId = mValues[i][0];
      const memberPayments = paymentsMap[mId] || paymentsMap[mId.toString()] || paymentsMap[Number(mId)] || {};
      members.push({
        id: Number(mId) || mId,
        name: mValues[i][1] ? mValues[i][1].toString() : '',
        paid: parseSafeNumber(mValues[i][2]),
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
        packPrice = parseSafeNumber(pValues[i][3]);
        totalPrice = parseSafeNumber(pValues[i][4], quantity * packPrice);
        unitPrice = parseSafeNumber(pValues[i][5], Math.round(packPrice / 12));
        note = pValues[i][6] || '';
        valDepleted = pValues[i][7];
      } else {
        label = pValues[i][1] || '';
        quantity = 1;
        packPrice = parseSafeNumber(pValues[i][2]);
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
        isDepleted: (valDepleted === true || valDepleted === 'true' || valDepleted === 'Hết' || valDepleted === 'Đã hết')
      });
    }
  }

  // Tự động tính toán tiền đã nộp của Kantan (Chủ Quỹ)
  const isKantan = (m) => m && m.name && m.name.trim().toLowerCase() === 'kantan';
  const kantanMember = members.find(m => isKantan(m));
  if (kantanMember) {
    let sessionStats = {};
    sessions.forEach(s => {
      let count = 0;
      members.forEach(m => { if (m.attendance && m.attendance[s.id]) count++; });
      const totalCost = (Number(s.shuttles) || 0) * (Number(s.unitPrice) || 0);
      sessionStats[s.id] = { count, totalCost, costPerPerson: count > 0 ? (totalCost / count) : 0 };
    });

    const totalBoughtShuttles = shuttleBatches.reduce((sum, b) => {
      const qty = Number(b.quantity) || 1;
      const pack = Number(b.packPrice) || 0;
      return sum + (Number(b.totalPrice) || (qty * pack));
    }, 0);

    let memberDeductions = 0;
    members.forEach(m => {
      if (isKantan(m)) return;
      let mBill = 0;
      sessions.forEach(s => {
        if (m.attendance && m.attendance[s.id] && sessionStats[s.id]) {
          mBill += sessionStats[s.id].costPerPerson;
        }
      });
      const mPaid = Number(m.paid) || 0;
      const deduction = (mPaid >= mBill) ? mBill : mPaid;
      memberDeductions += deduction;
    });

    kantanMember.paid = totalBoughtShuttles - memberDeductions;
  }

  return { sessions, members, qrInfo, shuttleBatches };
}

// 4. HÀM GHI DỮ LIỆU VÀO GOOGLE SHEETS (SIÊU TỐC VỚI BATCH CLEAR & BATCH UPDATE)
async function saveToSheets(sheets, spreadsheetId, payload) {
  await ensureSheetsExist(sheets, spreadsheetId);

  const { sessions, members, qrInfo, shuttleBatches } = payload;

  // A. Chuẩn bị dữ liệu Sessions
  const sData = [['ID', 'Ngày/Thứ', 'Số Cầu', 'Đơn Giá']];
  if (sessions && Array.isArray(sessions)) {
    sessions.forEach(s => sData.push([s.id, s.date, s.shuttles, s.unitPrice]));
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
          row.push(m.attendance && m.attendance[s.id] ? 'Yes' : 'No');
        });
      }
      mData.push(row);
    });
  }

  // C. Chuẩn bị dữ liệu Config
  let rawQrUrl = (qrInfo && qrInfo.qrUrl) ? qrInfo.qrUrl : '';
  if (rawQrUrl.length > 49000) rawQrUrl = rawQrUrl.substring(0, 49000);
  const cData = [
    ['Key', 'Value'],
    ['bankName', (qrInfo && qrInfo.bankName) ? qrInfo.bankName : ''],
    ['bankAcc', (qrInfo && qrInfo.bankAcc) ? qrInfo.bankAcc : ''],
    ['bankOwner', (qrInfo && qrInfo.bankOwner) ? qrInfo.bankOwner : ''],
    ['qrUrl', rawQrUrl]
  ];

  // D. Chuẩn bị dữ liệu Prices
  const pData = [['ID', 'Lần Mua', 'Số Hộp', 'Giá 1 Hộp (12 Trái)', 'Tổng Tiền Mua Cầu', 'Đơn Giá 1 Trái', 'Ghi chú', 'Tình trạng']];
  if (shuttleBatches && Array.isArray(shuttleBatches)) {
    shuttleBatches.forEach(b => {
      const qty = Number(b.quantity) || 1;
      const pack = Number(b.packPrice) || 0;
      const total = Number(b.totalPrice) || (qty * pack);
      const unit = Number(b.unitPrice) || Math.round(pack / 12);
      pData.push([b.id, b.label, qty, pack, total, unit, b.note || '', b.isDepleted ? 'Hết' : 'Còn']);
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

  // 1. Xóa sạch vùng cũ qua batchClear (1 request duy nhất)
  try {
    await sheets.spreadsheets.values.batchClear({
      spreadsheetId: spreadsheetId,
      requestBody: {
        ranges: [
          'Sessions!A1:Z500',
          'Members!A1:Z500',
          'Config!A1:B20',
          'Prices!A1:H100',
          'Payments!A1:Z500'
        ]
      }
    });
  } catch (clearErr) {
    console.warn('Cảnh báo batchClear:', clearErr.message);
  }

  // 2. Ghi toàn bộ dữ liệu mới qua batchUpdate (1 request duy nhất, siêu tốc)
  const updateRes = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: 'Sessions!A1', values: sData },
        { range: 'Members!A1', values: mData },
        { range: 'Config!A1', values: cData },
        { range: 'Prices!A1', values: pData },
        { range: 'Payments!A1', values: payData }
      ]
    }
  });

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
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
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
          error: 'Lỗi kết nối proxy tới Google Sheets: ' + proxyErr.message
        });
      }
    }

    if (req.method === 'POST') {
      try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
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

      if (action === 'saveData') {
        const payload = body.payload || body;
        await saveToSheets(sheets, spreadsheetId, payload);
        return res.status(200).json({
          success: true,
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
