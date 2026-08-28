const SPREADSHEET_ID = '1-425z-aI4Im3b_eZ-ky5B47wm1R_zBa5uYdwCrnswM0';
const ADMIN_EMAILS = ['sayoonara.htq90@gmail.com'];
const DEFAULT_ADMIN_PIN = '19901990';

/**
 * Lấy đối tượng Spreadsheet (hỗ trợ cả Script nhúng trong Sheet lẫn Script độc lập Standalone)
 */
function getSpreadsheet() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) return ss;
  } catch (e) {}

  try {
    if (SPREADSHEET_ID && !SPREADSHEET_ID.includes('PLACEHOLDER')) {
      return SpreadsheetApp.openById(SPREADSHEET_ID);
    }
  } catch (e) {
    Logger.log('Lỗi mở Spreadsheet: ' + e);
  }

  throw new Error('Không thể kết nối đến Google Spreadsheet. Hãy kiểm tra lại Spreadsheet ID (' + SPREADSHEET_ID + ') hoặc cấp quyền truy cập!');
}

/**
 * Đảm bảo các tab sheet cần thiết luôn tồn tại
 */
function ensureSheetsExist(ss) {
  const required = ['Sessions', 'Members', 'Config', 'Prices', 'Payments'];
  required.forEach(name => {
    if (!ss.getSheetByName(name)) {
      ss.insertSheet(name);
    }
  });
}

function doGet(e) {
  // 1. Phục vụ REST API lấy dữ liệu JSON (cho Vercel / GitHub Pages / Mobile App / Fallback)
  if (e && e.parameter && (e.parameter.action === 'loadData' || e.parameter.api === 'true')) {
    try {
      const data = getFromSheets();
      const jsonStr = JSON.stringify({
        success: true,
        data: data,
        timestamp: new Date().toISOString()
      });
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
  return { email: email, isAdmin: true };
}

function isAdminUser() {
  return true; // Cho phép thực thi lệnh lưu từ giao diện đã xác thực PIN
}

function getFromSheets() {
  const ss = getSpreadsheet();
  ensureSheetsExist(ss);

  let sSheet = ss.getSheetByName('Sessions');
  let mSheet = ss.getSheetByName('Members');
  let cSheet = ss.getSheetByName('Config');
  let pSheet = ss.getSheetByName('Prices');
  
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
  
  // Tự động khởi tạo dữ liệu mẫu nếu bảng tính hoàn toàn trống
  if (sessions.length === 0 && members.length === 0) {
    const seed = getDefaultSeedData();
    saveToSheets(seed);
    return seed;
  }

  return { sessions: sessions, members: members, qrInfo: qrInfo, shuttleBatches: shuttleBatches };
}

function saveToSheets(payloadData) {
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
  const ss = getSpreadsheet();
  ensureSheetsExist(ss);
  
  // 1. Lưu Sessions
  let sSheet = ss.getSheetByName('Sessions');
  sSheet.clearContents();
  let sData = [['ID', 'Ngày/Thứ', 'Số Cầu', 'Đơn Giá']];
  if (sessions) sessions.forEach(s => sData.push([s.id, s.date, s.shuttles, s.unitPrice]));
  if (sData.length > 0) {
    sSheet.getRange(1, 1, sData.length, sData[0].length).setValues(sData);
  }
  
  // 2. Lưu Members
  let mSheet = ss.getSheetByName('Members');
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
  let cSheet = ss.getSheetByName('Config');
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
  let pSheet = ss.getSheetByName('Prices');
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
  let paySheet = ss.getSheetByName('Payments');
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
 * Dữ liệu mẫu chuẩn của CLB Victoria
 */
function getDefaultSeedData() {
  return {
    sessions: [
      {"id":"s1","date":"Thứ 5 - 23/7","shuttles":10,"unitPrice":12917},
      {"id":"s2","date":"Thứ 3 - 28/7","shuttles":8,"unitPrice":22791.5},
      {"id":"s3","date":"Thứ 5 - 30/7","shuttles":18,"unitPrice":16027.67},
      {"id":"s4","date":"Thứ 3 - 4/8","shuttles":3,"unitPrice":26667},
      {"id":"s5","date":"Thứ 5 - 6/8","shuttles":9,"unitPrice":26667},
      {"id":"s1786346767984","date":"Thứ 5 - 13/8","shuttles":12,"unitPrice":12500},
      {"id":"s1786860156561","date":"Thứ 7 - 15/08","shuttles":12,"unitPrice":12500},
      {"id":"s1787069288069","date":"Thứ 3 - 18/08","shuttles":6,"unitPrice":12500},
      {"id":"s1787290788391","date":"Thứ 5 - 20/8","shuttles":15,"unitPrice":12500},
      {"id":"s1787714092986","date":"Thứ 3 - 25/8","shuttles":6,"unitPrice":24167}
    ],
    members: [
      {"id":1,"name":"A Phương","paid":60000,"attendance":{"s1":false,"s2":false,"s3":true,"s4":false,"s5":true,"s1786346767984":false,"s1786860156561":false,"s1787069288069":false,"s1787290788391":false,"s1787714092986":false},"payments":{"s1":0,"s2":0,"s3":0,"s4":0,"s5":0,"s1786346767984":0,"s1786860156561":0,"s1787069288069":0,"s1787290788391":0,"s1787714092986":0}},
      {"id":2,"name":"A Đức","paid":127000,"attendance":{"s1":false,"s2":false,"s3":false,"s4":true,"s5":true,"s1786346767984":true,"s1786860156561":true,"s1787069288069":true,"s1787290788391":true,"s1787714092986":true},"payments":{"s1":66000,"s2":61000,"s3":0,"s4":0,"s5":0,"s1786346767984":0,"s1786860156561":0,"s1787069288069":0,"s1787290788391":0,"s1787714092986":0}},
      {"id":3,"name":"A Toàn","paid":500000,"attendance":{"s1":true,"s2":true,"s3":true,"s4":false,"s5":true,"s1786346767984":true,"s1786860156561":true,"s1787069288069":true,"s1787290788391":true,"s1787714092986":true},"payments":{"s1":500000,"s2":0,"s3":0,"s4":0,"s5":0,"s1786346767984":0,"s1786860156561":0,"s1787069288069":0,"s1787290788391":0,"s1787714092986":0}},
      {"id":4,"name":"Cô Hà","paid":100000,"attendance":{"s1":false,"s2":false,"s3":false,"s4":false,"s5":true,"s1786346767984":true,"s1786860156561":false,"s1787069288069":false,"s1787290788391":true,"s1787714092986":false},"payments":{"s1":100000,"s2":0,"s3":0,"s4":0,"s5":0,"s1786346767984":0,"s1786860156561":0,"s1787069288069":0,"s1787290788391":0,"s1787714092986":0}},
      {"id":5,"name":"Song Anh","paid":176000,"attendance":{"s1":true,"s2":true,"s3":true,"s4":true,"s5":false,"s1786346767984":false,"s1786860156561":false,"s1787069288069":true,"s1787290788391":true,"s1787714092986":true},"payments":{"s1":91000,"s2":85000,"s3":0,"s4":0,"s5":0,"s1786346767984":0,"s1786860156561":0,"s1787069288069":0,"s1787290788391":0,"s1787714092986":0}},
      {"id":6,"name":"Lộc","paid":135000,"attendance":{"s1":false,"s2":true,"s3":true,"s4":true,"s5":true,"s1786346767984":false,"s1786860156561":true,"s1787069288069":false,"s1787290788391":false,"s1787714092986":false},"payments":{"s1":120000,"s2":15000,"s3":0,"s4":0,"s5":0,"s1786346767984":0,"s1786860156561":0,"s1787069288069":0,"s1787290788391":0,"s1787714092986":0}},
      {"id":7,"name":"Lâm","paid":160000,"attendance":{"s1":false,"s2":true,"s3":true,"s4":false,"s5":true,"s1786346767984":true,"s1786860156561":true,"s1787069288069":false,"s1787290788391":true,"s1787714092986":false},"payments":{"s1":70000,"s2":90000,"s3":0,"s4":0,"s5":0,"s1786346767984":0,"s1786860156561":0,"s1787069288069":0,"s1787290788391":0,"s1787714092986":0}},
      {"id":8,"name":"Tài","paid":222000,"attendance":{"s1":true,"s2":false,"s3":true,"s4":false,"s5":true,"s1786346767984":true,"s1786860156561":true,"s1787069288069":false,"s1787290788391":true,"s1787714092986":true},"payments":{"s1":22000,"s2":200000,"s3":0,"s4":0,"s5":0,"s1786346767984":0,"s1786860156561":0,"s1787069288069":0,"s1787290788391":0,"s1787714092986":0}},
      {"id":9,"name":"Nghĩa","paid":100000,"attendance":{"s1":true,"s2":false,"s3":true,"s4":false,"s5":false,"s1786346767984":true,"s1786860156561":true,"s1787069288069":false,"s1787290788391":false,"s1787714092986":true},"payments":{"s1":100000,"s2":0,"s3":0,"s4":0,"s5":0,"s1786346767984":0,"s1786860156561":0,"s1787069288069":0,"s1787290788391":0,"s1787714092986":0}},
      {"id":10,"name":"Hoàng Anh","paid":142000,"attendance":{"s1":true,"s2":false,"s3":true,"s4":false,"s5":true,"s1786346767984":true,"s1786860156561":true,"s1787069288069":false,"s1787290788391":true,"s1787714092986":false},"payments":{"s1":0,"s2":0,"s3":0,"s4":0,"s5":0,"s1786346767984":0,"s1786860156561":0,"s1787069288069":0,"s1787290788391":0,"s1787714092986":0}},
      {"id":11,"name":"Kantan","paid":752243.01,"attendance":{"s1":true,"s2":true,"s3":true,"s4":true,"s5":true,"s1786346767984":true,"s1786860156561":true,"s1787069288069":true,"s1787290788391":true,"s1787714092986":true},"payments":{"s1":0,"s2":0,"s3":0,"s4":0,"s5":0,"s1786346767984":0,"s1786860156561":0,"s1787069288069":0,"s1787290788391":0,"s1787714092986":0}}
    ],
    shuttleBatches: [
      {"id":"p1","label":"Lần 1","quantity":1,"packPrice":155000,"totalPrice":155000,"unitPrice":12917,"note":"88 - 95%","isDepleted":true},
      {"id":"p2","label":"Lần 2","quantity":1,"packPrice":313000,"totalPrice":313000,"unitPrice":26083,"note":"Cầu Vina - new","isDepleted":true},
      {"id":"p3","label":"Lần 3","quantity":1,"packPrice":132000,"totalPrice":132000,"unitPrice":11000,"note":"0.95","isDepleted":true},
      {"id":"p1786165949984","label":"Lần 4","quantity":1,"packPrice":320000,"totalPrice":320000,"unitPrice":26667,"note":"88 - new","isDepleted":true},
      {"id":"p1786346700232","label":"Lần 5","quantity":1,"packPrice":150000,"totalPrice":150000,"unitPrice":12500,"note":"88 - 90%","isDepleted":true},
      {"id":"p1786346717915","label":"Lần 6","quantity":1,"packPrice":150000,"totalPrice":150000,"unitPrice":12500,"note":"88 - 90%","isDepleted":true},
      {"id":"p1787024096209","label":"Lần 7","quantity":1,"packPrice":150000,"totalPrice":150000,"unitPrice":12500,"note":"88 -90%","isDepleted":true},
      {"id":"p1787024120558","label":"Lần 8","quantity":1,"packPrice":150000,"totalPrice":150000,"unitPrice":12500,"note":"88 - 90%","isDepleted":false},
      {"id":"p1787581904340","label":"24/08 - 2 ống VBCS","quantity":2,"packPrice":290000,"totalPrice":580000,"unitPrice":24167,"note":"","isDepleted":false}
    ],
    qrInfo: {
      bankName: "MB Bank",
      bankAcc: "1903",
      bankOwner: "NGUYEN VAN A",
      qrUrl: ""
    }
  };
}

/**
 * Hàm thủ công để Admin chạy trong Apps Script Editor khi muốn tạo lại toàn bộ dữ liệu mẫu
 */
function setupInitialData() {
  const seed = getDefaultSeedData();
  saveToSheets(seed);
  Logger.log('Đã khởi tạo dữ liệu mẫu thành công vào Google Sheets!');
}

/**
 * Proxy Server-side để gọi Gemini AI bảo mật từ Apps Script
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