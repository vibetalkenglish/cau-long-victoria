const ADMIN_EMAILS = ['sayoonara.htq90@gmail.com'];
const DEFAULT_ADMIN_PIN = '123456';

function doGet(e) {
  // 1. Phục vụ REST API lấy dữ liệu JSON (cho Vercel / GitHub Pages / Mobile App)
  if (e && e.parameter && (e.parameter.action === 'loadData' || e.parameter.api === 'true')) {
    try {
      const cache = CacheService.getScriptCache();
      const cached = cache.get('CLB_SHEET_DATA_JSON');
      if (cached) {
        return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);
      }
      
      const data = getFromSheets();
      const jsonStr = JSON.stringify({
        success: true,
        data: data,
        timestamp: new Date().toISOString()
      });
      
      try {
        // Cache dữ liệu 30 phút để tăng tốc độ phản hồi tức thì
        cache.put('CLB_SHEET_DATA_JSON', jsonStr, 1800);
      } catch (cacheErr) {}

      return ContentService.createTextOutput(jsonStr).setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: err.toString()
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  // 2. Mặc định trả về giao diện HTML cho Google Apps Script Web App
  return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('CẦU LÔNG VICTORIA')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  try {
    let requestData = {};
    if (e && e.postData && e.postData.contents) {
      requestData = JSON.parse(e.postData.contents);
    } else if (e && e.parameter) {
      requestData = e.parameter;
    }

    const action = requestData.action;

    // Action 1: Lưu toàn bộ dữ liệu vào Google Sheets
    if (action === 'saveData') {
      const payload = requestData.payload || requestData;
      saveToSheets(payload);
      
      // Xóa cache cũ để nạp dữ liệu mới nhất
      try {
        const cache = CacheService.getScriptCache();
        cache.remove('CLB_SHEET_DATA_JSON');
      } catch (cacheErr) {}

      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        message: 'Đã lưu dữ liệu vào Google Sheets thành công!'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // Action 2: Gọi Gemini AI Proxy
    if (action === 'askGemini') {
      const promptText = requestData.prompt || '';
      const clubContext = requestData.context || '';
      const reply = callGeminiAI(promptText, clubContext);
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        reply: reply
      })).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: 'Hành động không hợp lệ (Unknown action)'
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function getActiveUserEmail() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (err) {
    return '';
  }
}

function getUserRole() {
  const email = getActiveUserEmail();
  const isAdmin = ADMIN_EMAILS.includes(email.toLowerCase());
  return { email: email, isAdmin: isAdmin };
}

function isAdminUser() {
  const email = getActiveUserEmail();
  if (!email) return true; // Khi gọi qua Web App API từ Vercel hoặc test local
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

function getFromSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sSheet = ss.getSheetByName('Sessions') || ss.insertSheet('Sessions');
  let mSheet = ss.getSheetByName('Members') || ss.insertSheet('Members');
  let cSheet = ss.getSheetByName('Config') || ss.insertSheet('Config');
  let pSheet = ss.getSheetByName('Prices') || ss.insertSheet('Prices');
  
  // 1. Đọc dữ liệu Sessions
  let sessions = [];
  let sValues = sSheet.getDataRange().getValues();
  if (sValues.length > 1) {
    for(let i = 1; i < sValues.length; i++) {
       if (!sValues[i][0]) continue;
       sessions.push({
         id: sValues[i][0].toString(),
         date: sValues[i][1],
         shuttles: Number(sValues[i][2]) || 0,
         unitPrice: Number(sValues[i][3]) || 0
       });
    }
  }
  
  // 2. Đọc dữ liệu Members & Payments
  let paySheet = ss.getSheetByName('Payments');
  let paymentsMap = {};
  if (paySheet) {
    let payValues = paySheet.getDataRange().getValues();
    if (payValues.length > 1) {
      let payHeaders = payValues[0];
      for (let i = 1; i < payValues.length; i++) {
        let mId = payValues[i][0];
        if (!mId) continue;
        paymentsMap[mId] = {};
        for (let j = 2; j < payHeaders.length; j++) {
          let sId = payHeaders[j];
          paymentsMap[mId][sId] = Number(payValues[i][j]) || 0;
        }
      }
    }
  }

  let members = [];
  let mValues = mSheet.getDataRange().getValues();
  if (mValues.length > 1) {
    let headers = mValues[0];
    for(let i = 1; i < mValues.length; i++) {
       if (!mValues[i][0] && !mValues[i][1]) continue;
       let att = {};
       for(let j = 3; j < headers.length; j++) {
         let val = mValues[i][j];
         att[headers[j]] = (val === true || val === 'true' || val === 'TRUE' || val === 'Yes');
       }
       let mId = mValues[i][0];
       members.push({
         id: Number(mId) || mId,
         name: mValues[i][1] ? mValues[i][1].toString() : '',
         paid: Number(mValues[i][2]) || 0,
         attendance: att,
         payments: paymentsMap[mId] || {}
       });
    }
  }
  
  // 3. Đọc cấu hình QR
  let qrInfo = {};
  let cValues = cSheet.getDataRange().getValues();
  if (cValues.length > 1) {
    for(let i = 1; i < cValues.length; i++) {
       if (cValues[i][0]) {
         qrInfo[cValues[i][0]] = cValues[i][1];
       }
    }
  }

  // 4. Đọc dữ liệu Bảng Giá Mua Ống Cầu
  let shuttleBatches = [];
  let pValues = pSheet.getDataRange().getValues();
  if (pValues.length > 1) {
    for(let i = 1; i < pValues.length; i++) {
       if (!pValues[i][0]) continue;
       let isNewFormat = (pValues[0].length >= 8 || pValues[0][2] === 'Số Hộp' || pValues[0][4] === 'Tổng Tiền Mua Cầu');
       
       let label, quantity, packPrice, totalPrice, unitPrice, note, valDepleted;
       if (isNewFormat && pValues[i].length >= 8) {
         label = pValues[i][1];
         quantity = Number(pValues[i][2]) || 1;
         packPrice = Number(pValues[i][3]) || 0;
         totalPrice = Number(pValues[i][4]) || (quantity * packPrice);
         unitPrice = Number(pValues[i][5]) || Math.round(packPrice / 12);
         note = pValues[i][6] || '';
         valDepleted = pValues[i][7];
       } else {
         label = pValues[i][1];
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
  
  return { sessions: sessions, members: members, qrInfo: qrInfo, shuttleBatches: shuttleBatches };
}

function saveToSheets(payloadData) {
  // 0. XÁC THỰC BẢO MẬT ADMIN PHÍA SERVER
  if (!isAdminUser()) {
    throw new Error('Từ chối truy cập: Bạn không có quyền Admin để thực hiện thao tác này!');
  }

  if (!payloadData) return false;
  let payload;
  try {
    payload = typeof payloadData === 'string' ? JSON.parse(payloadData) : payloadData;
  } catch (e) {
    return false;
  }

  const { sessions, members, qrInfo, shuttleBatches } = payload;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. Lưu Sessions (dùng clearContents để giữ nguyên format ô)
  let sSheet = ss.getSheetByName('Sessions') || ss.insertSheet('Sessions');
  sSheet.clearContents();
  let sData = [['ID', 'Ngày/Thứ', 'Số Cầu', 'Đơn Giá']];
  if (sessions) sessions.forEach(s => sData.push([s.id, s.date, s.shuttles, s.unitPrice]));
  if (sData.length > 0) {
    sSheet.getRange(1, 1, sData.length, sData[0].length).setValues(sData);
  }
  
  // 2. Lưu Members
  let mSheet = ss.getSheetByName('Members') || ss.insertSheet('Members');
  mSheet.clearContents();
  let mHeaders = ['ID', 'Tên', 'Đã Thanh Toán'];
  if (sessions) sessions.forEach(s => mHeaders.push(s.id));
  let mData = [mHeaders];
  
  if (members) {
    members.forEach(m => {
      let row = [m.id, m.name, m.paid];
      if (sessions) {
        sessions.forEach(s => {
          row.push(m.attendance[s.id] ? 'Yes' : 'No');
        });
      }
      mData.push(row);
    });
  }
  if (mData.length > 0 && mData[0].length > 0) {
    mSheet.getRange(1, 1, mData.length, mData[0].length).setValues(mData);
  }
  
  // 3. Lưu cấu hình QR
  let cSheet = ss.getSheetByName('Config') || ss.insertSheet('Config');
  cSheet.clearContents();
  let rawQrUrl = (qrInfo && qrInfo.qrUrl) ? qrInfo.qrUrl : '';
  if (rawQrUrl.length > 49000) {
    rawQrUrl = rawQrUrl.substring(0, 49000);
  }
  let cData = [
    ['Key', 'Value'],
    ['bankName', (qrInfo && qrInfo.bankName) ? qrInfo.bankName : ''],
    ['bankAcc', (qrInfo && qrInfo.bankAcc) ? qrInfo.bankAcc : ''],
    ['bankOwner', (qrInfo && qrInfo.bankOwner) ? qrInfo.bankOwner : ''],
    ['qrUrl', rawQrUrl]
  ];
  cSheet.getRange(1, 1, cData.length, cData[0].length).setValues(cData);

  // 4. Lưu dữ liệu Bảng Giá Ống Cầu
  let pSheet = ss.getSheetByName('Prices') || ss.insertSheet('Prices');
  pSheet.clearContents();
  let pData = [['ID', 'Lần Mua', 'Số Hộp', 'Giá 1 Hộp (12 Trái)', 'Tổng Tiền Mua Cầu', 'Đơn Giá 1 Trái', 'Ghi chú', 'Tình trạng']];
  if (shuttleBatches && shuttleBatches.length > 0) {
    shuttleBatches.forEach(b => {
      let qty = Number(b.quantity) || 1;
      let pack = Number(b.packPrice) || 0;
      let total = Number(b.totalPrice) || (qty * pack);
      let unit = Number(b.unitPrice) || Math.round(pack / 12);
      pData.push([b.id, b.label, qty, pack, total, unit, b.note || '', b.isDepleted ? 'Hết' : 'Còn']);
    });
  }
  if (pData.length > 0) {
    pSheet.getRange(1, 1, pData.length, pData[0].length).setValues(pData);
  }

  // 5. Lưu dữ liệu Payments (Chi tiết tiền đóng từng buổi của thành viên)
  let paySheet = ss.getSheetByName('Payments') || ss.insertSheet('Payments');
  paySheet.clearContents();
  let payHeaders = ['MemberID', 'MemberName'];
  if (sessions) sessions.forEach(s => payHeaders.push(s.id));
  let payData = [payHeaders];
  if (members) {
    members.forEach(m => {
      let row = [m.id, m.name];
      if (sessions) {
        sessions.forEach(s => {
          let pVal = (m.payments && m.payments[s.id]) ? Number(m.payments[s.id]) : 0;
          row.push(pVal);
        });
      }
      payData.push(row);
    });
  }
  if (payData.length > 0 && payData[0].length > 0) {
    paySheet.getRange(1, 1, payData.length, payData[0].length).setValues(payData);
  }
  
  return true;
}

/**
 * Proxy Server-side để gọi Gemini AI bảo mật từ Apps Script
 * Đọc API Key từ ScriptProperties hoặc hằng số phía server.
 */
function callGeminiAI(promptText, clubContext) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
  if (!apiKey) {
    return 'Lỗi: Chưa cấu hình GEMINI_API_KEY trong Script Properties của Google Apps Script sếp ơi!';
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + apiKey;
  const systemInstruction = "Bạn là trợ lý AI thông minh, vui vẻ và rất khéo léo dành cho người quản lý CLB Cầu Lông. Xưng là 'tôi' và gọi người dùng là 'Sếp'. Dùng tiếng Việt chuẩn, thêm emoji.";
  
  const payload = {
    contents: [{
      parts: [{ text: (clubContext ? clubContext + '\n\n' : '') + promptText }]
    }],
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    }
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const json = JSON.parse(response.getContentText());
    if (json.candidates && json.candidates[0] && json.candidates[0].content) {
      return json.candidates[0].content.parts[0].text;
    } else if (json.error) {
      return 'Lỗi từ Gemini AI: ' + json.error.message;
    }
    return 'Không nhận được phản hồi từ Gemini AI.';
  } catch (err) {
    return 'Lỗi kết nối Server Apps Script: ' + err.toString();
  }
}