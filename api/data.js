const { google } = require('googleapis');

// 1. CẤU HÌNH XÁC THỰC GOOGLE SHEETS API
function getGoogleAuth() {
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

const DEFAULT_SHEET_ID = process.env.GOOGLE_SHEET_ID || '';

// 2. HÀM ĐỌC DỮ LIỆU TỪ GOOGLE SHEETS (SIÊU TỐC QUA BATCH GET)
async function getFromSheets(sheets, spreadsheetId) {
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
    // Nếu sheet chưa tồn tại, thử đọc từng sheet cơ bản
    console.error('Lỗi batchGet sheets:', err.message);
    throw err;
  }

  const sValues = (valueRanges[0] && valueRanges[0].values) || [];
  const mValues = (valueRanges[1] && valueRanges[1].values) || [];
  const cValues = (valueRanges[2] && valueRanges[2].values) || [];
  const pValues = (valueRanges[3] && valueRanges[3].values) || [];
  const payValues = (valueRanges[4] && valueRanges[4].values) || [];

  // A. Sessions
  const sessions = [];
  if (sValues.length > 1) {
    for (let i = 1; i < sValues.length; i++) {
      if (!sValues[i][0]) continue;
      sessions.push({
        id: sValues[i][0].toString(),
        date: sValues[i][1] || '',
        shuttles: Number(sValues[i][2]) || 0,
        unitPrice: Number(sValues[i][3]) || 0
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
      for (let j = 2; j < payHeaders.length; j++) {
        const sId = payHeaders[j];
        paymentsMap[mId][sId] = Number(payValues[i][j]) || 0;
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
      members.push({
        id: Number(mId) || mId,
        name: mValues[i][1] ? mValues[i][1].toString() : '',
        paid: Number(mValues[i][2]) || 0,
        attendance: att,
        payments: paymentsMap[mId] || {}
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
        quantity = Number(pValues[i][2]) || 1;
        packPrice = Number(pValues[i][3]) || 0;
        totalPrice = Number(pValues[i][4]) || (quantity * packPrice);
        unitPrice = Number(pValues[i][5]) || Math.round(packPrice / 12);
        note = pValues[i][6] || '';
        valDepleted = pValues[i][7];
      } else {
        label = pValues[i][1] || '';
        quantity = 1;
        packPrice = Number(pValues[i][2]) || 0;
        totalPrice = packPrice;
        unitPrice = Number(pValues[i][3]) || Math.round(packPrice / 12);
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
        isDepleted: (valDepleted === true || valDepleted === 'true' || valDepleted === 'TRUE' || valDepleted === 'Hết')
      });
    }
  }

  return { sessions, members, qrInfo, shuttleBatches };
}

// 3. HÀM GHI DỮ LIỆU VÀO GOOGLE SHEETS
async function saveToSheets(sheets, spreadsheetId, payload) {
  const { sessions, members, qrInfo, shuttleBatches } = payload;

  // A. Chuẩn bị dữ liệu Sessions
  const sData = [['ID', 'Ngày/Thứ', 'Số Cầu', 'Đơn Giá']];
  if (sessions) sessions.forEach(s => sData.push([s.id, s.date, s.shuttles, s.unitPrice]));

  // B. Chuẩn bị dữ liệu Members
  const mHeaders = ['ID', 'Tên', 'Đã Thanh Toán'];
  if (sessions) sessions.forEach(s => mHeaders.push(s.id));
  const mData = [mHeaders];
  if (members) {
    members.forEach(m => {
      const row = [m.id, m.name, m.paid];
      if (sessions) {
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
  if (shuttleBatches && shuttleBatches.length > 0) {
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
  if (sessions) sessions.forEach(s => payHeaders.push(s.id));
  const payData = [payHeaders];
  if (members) {
    members.forEach(m => {
      const row = [m.id, m.name];
      if (sessions) {
        sessions.forEach(s => {
          const pVal = (m.payments && m.payments[s.id]) ? Number(m.payments[s.id]) : 0;
          row.push(pVal);
        });
      }
      payData.push(row);
    });
  }

  // Xóa nội dung cũ và ghi dữ liệu mới theo từng sheet
  const sheetsToUpdate = [
    { range: 'Sessions!A1:Z500', values: sData },
    { range: 'Members!A1:Z500', values: mData },
    { range: 'Config!A1:B10', values: cData },
    { range: 'Prices!A1:H100', values: pData },
    { range: 'Payments!A1:Z500', values: payData }
  ];

  for (const item of sheetsToUpdate) {
    try {
      // Clear vùng cũ
      await sheets.spreadsheets.values.clear({
        spreadsheetId: spreadsheetId,
        range: item.range
      });
      // Ghi vùng mới
      await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId,
        range: item.range.split(':')[0],
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: item.values }
      });
    } catch (sheetErr) {
      console.warn(`Lưu sheet ${item.range} có cảnh báo:`, sheetErr.message);
    }
  }

  return true;
}

// 4. HÀM GỌI GEMINI AI
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

// 5. SERVERLESS HANDLER CHO VERCEL
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

  // Xử lý trường hợp chưa cấu hình Service Account trên Vercel
  if (!auth || !spreadsheetId) {
    const errorMsg = 'Chưa cấu hình biến môi trường GOOGLE_SHEET_ID hoặc GOOGLE_SERVICE_ACCOUNT trên Vercel!';
    if (req.method === 'GET') {
      return res.status(200).json({
        success: false,
        isConfigRequired: true,
        message: errorMsg,
        guide: {
          step1: 'Vào Vercel Project Settings -> Environment Variables',
          step2: 'Thêm GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY'
        }
      });
    }
    return res.status(400).json({ success: false, error: errorMsg });
  }

  const sheets = google.sheets({ version: 'v4', auth });

  // A. GET /api/data -> Đọc dữ liệu từ Google Sheets
  if (req.method === 'GET') {
    try {
      const data = await getFromSheets(sheets, spreadsheetId);
      // Cache nhẹ 60 giây ở Vercel Edge CDN để giảm tải và tăng tốc
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
      return res.status(200).json({
        success: true,
        data: data,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
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
      return res.status(500).json({
        success: false,
        error: 'Lỗi xử lý POST request: ' + err.message
      });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
