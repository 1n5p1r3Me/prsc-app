// ===============================
// main.js — PRSC Electron Main (icon‑ready)
// ===============================
// NOTE: Only icon handling was added/changed. App logic is unchanged.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const odbc = require('odbc');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
let Store = require('electron-store');
Store = Store.default || Store; // handle ESM default

// ---------- Store ----------
const store = new Store({
  name: 'prsc-settings',
  defaults: { accdbPath: '', exportsDir: '' }
});

// ---------- Helpers ----------
const b = (name) => `[${String(name).replace(/]/g, ']]')}]`; // Access bracket escape
const isTrue = (v) => (v === true || v === 1 || v === -1 || String(v ?? '').toLowerCase() === 'true' || String(v ?? '').toLowerCase() === 'yes');
const dayTag = (d = new Date()) => new Date(d).toISOString().slice(0,10);

// NEW: find a Windows .ico for BrowserWindow
function findWinIcon() {
  const tryPaths = [
    path.join(__dirname, 'build', 'icons', 'prsc.ico'),
    path.join(__dirname, 'assets', 'icons', 'prsc.ico'),
    path.join(__dirname, 'icons', 'prsc.ico'),
    path.join(process.resourcesPath || '', 'build', 'icons', 'prsc.ico'), // when packaged
  ].filter(Boolean);
  for (const p of tryPaths) { if (p && fs.existsSync(p)) return p; }
  return undefined; // let Electron fall back to default dev icon
}

let mainWindow;
function createWindow () {
  const icon = findWinIcon();
  mainWindow = new BrowserWindow({
    width: 1200,
    height:1200,
    icon, // <-- icon applied when present
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Try Vite dev server first, then built UI
  (async () => {
    try { await mainWindow.loadURL('http://localhost:5173'); }
    catch { try { await mainWindow.loadURL('http://localhost:5174'); }
      catch { try { await mainWindow.loadURL('http://localhost:5175'); }
        catch { await mainWindow.loadFile(path.join(__dirname, 'ui', 'dist', 'index.html')); }
      }
    }
  })();
}

app.setAppUserModelId('au.org.prsc.checkin'); // Windows taskbar grouping / notifications

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---------- Access / ODBC ----------
function getConnStr () {
  const accdbPath = store.get('accdbPath');
  if (!accdbPath) throw new Error('No Access database selected.');
  return `Driver={Microsoft Access Driver (*.mdb, *.accdb)};Dbq=${accdbPath};Uid=Admin;Pwd=;`;
}

ipcMain.handle('getSavedDbPath', async () => store.get('accdbPath') || null);
ipcMain.handle('get-saved-db-path', async () => store.get('accdbPath') || null); // alias

ipcMain.handle('pickAccessFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose Access database',
    filters: [{ name: 'Access', extensions: ['accdb', 'mdb'] }],
    properties: ['openFile']
  });
  if (!canceled && filePaths && filePaths[0]) {
    store.set('accdbPath', filePaths[0]);
    return filePaths[0];
  }
  return null;
});
ipcMain.handle('pick-access-file', async (_e) => ipcMain.invoke('pickAccessFile')); // alias

ipcMain.handle('fetchMembers', async () => {
  const cnx = await odbc.connect(getConnStr());
  const sql = `
    SELECT
      [Member No]              AS MemberNo,
      [Given name]             AS GivenTxt,
      [Surname]                AS SurnameTxt,
      [Primary e-mail address] AS EmailTxt,
      [Category H]             AS LicenceTxt,
      [Commencement Date]      AS JoinDate,
      IIF([Range Officer]<>0,-1,0)  AS IsRO,
      IIF([Current Member]<>0,-1,0) AS IsCurrent
    FROM ${b('PRSC Member data')}
    WHERE IIF([Current Member]<>0,-1,0) <> 0
  `;
  try {
    const rows = await cnx.query(sql);
    return rows.map(r => ({
      memberId : String(r.MemberNo ?? '').trim(),
      fullName : `${String(r.GivenTxt ?? '').trim()} ${String(r.SurnameTxt ?? '').trim()}`.trim(),
      email    : String(r.EmailTxt ?? '').trim(),
      licenceNo: String(r.LicenceTxt ?? '').trim(),
      joinDate : r.JoinDate || null,
      isRO     : isTrue(r.IsRO),
      isCurrent: isTrue(r.IsCurrent)
    })).sort((a,b)=>a.fullName.localeCompare(b.fullName));
  } finally { try { await cnx.close(); } catch {} }
});

// ---------- QR Export ----------
ipcMain.handle('exportQrPngs', async (_evt, rows = []) => {
  if (!Array.isArray(rows) || rows.length === 0) return { ok:false, error:'No rows' };
  const dir = path.join(app.getPath('documents'), 'PRSC', 'QR Codes', dayTag());
  fs.mkdirSync(dir, { recursive: true });
  let count = 0;
  for (const r of rows) {
    const payload = `PRSC|${r.memberId||''}|${r.fullName||''}|${r.joinDate||''}|financial|${r.licenceNo||''}`;
    const file = path.join(dir, `${String(r.memberId||'member').replace(/[^A-Za-z0-9_-]+/g,'_')}.png`);
    await QRCode.toFile(file, payload, { margin: 1, width: 512 });
    count++;
  }
  try { await shell.openPath(dir); } catch {}
  return { ok:true, count, folder: dir };
});

// ---------- Exports folder (CSV / workbooks destination) ----------
ipcMain.handle('getExportsDir', async () => store.get('exportsDir') || '');
ipcMain.handle('get-exports-dir', async () => store.get('exportsDir') || ''); // alias

ipcMain.handle('setExportsDir', async (_e, folder) => {
  if (folder && fs.existsSync(folder)) store.set('exportsDir', folder);
  return store.get('exportsDir') || '';
});
ipcMain.handle('set-exports-dir', async (e, folder) => ipcMain.invoke('setExportsDir', folder)); // alias

ipcMain.handle('pickExportsDir', async () => {
  const base = store.get('exportsDir') || app.getPath('documents');
  const res = await dialog.showOpenDialog({ title:'Choose participation folder', properties:['openDirectory','createDirectory'], defaultPath: base });
  if (res.canceled || !res.filePaths[0]) return { ok:false };
  store.set('exportsDir', res.filePaths[0]);
  return { ok:true, folder: res.filePaths[0] };
});
ipcMain.handle('pick-exports-dir', async (e) => ipcMain.invoke('pickExportsDir'));
ipcMain.handle('pickSaveFolder', async (e) => ipcMain.invoke('pickExportsDir')); // extra alias

// ---------- Member email helpers ----------
function buildMemberEmail(record = {}, roName = 'Range Officer') {
  const fmtDMY = (d) => { try { const dt = new Date(d); return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`; } catch { return d || ''; } };
  const firearm = record.firearm === 'H' ? 'Pistol (H)' : 'Long arms (A/B)';
  const comp    = record.competition === 'SILHOUETTE' ? 'Metal Silhouette' : 'Target';
  const subject = `Competition Participation for ${firearm} ${record.klass || ''} — ${fmtDMY(record.shootDate)}`.trim();
  const lines = [
    `Club: Pine Rivers Shooting Club`,
    `Location: Belmont SSAA`,
    `Member Name: ${record.name || ''}`,
    `Member #: ${record.memberId || ''}`,
    `Competition date: ${fmtDMY(record.shootDate)}`,
    `Category: ${firearm}`,
    `Class: ${record.klass || ''}`,
    `Competition: ${comp}`,
    record.licenceType ? `Licence: ${[record.licenceType, record.licenceNo].filter(Boolean).join(' ')}` : null,
    `Verified by Range Officer – ${roName}`
  ].filter(Boolean).join('\n');
  return { subject, text: lines };
}

function findLogoPath() {
  const tryPaths = [
    path.join(__dirname, 'assets', 'prsc-logo.png'),
    path.join(__dirname, 'prsc-logo.png'),
    path.join(__dirname, 'ui', 'public', 'prsc-logo.png')
  ];
  return tryPaths.find(p => fs.existsSync(p)) || null;
}

async function buildMemberPdf(record = {}, roName = 'Range Officer', clubName = 'Pine Rivers Shooting Club') {
  const fmtDMY = (d) => { try { const dt = new Date(d); return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`; } catch { return d || ''; } };
  const firearm = record.firearm === 'H' ? 'Pistol (H)' : 'Long arms (A/B)';
  const comp    = record.competition === 'SILHOUETTE' ? 'Metal Silhouette' : 'Target';
  const compDate = fmtDMY(record.shootDate);

  const doc = new PDFDocument({ size: 'A4', margin: 54 });
  const chunks = []; let resolveFn, rejectFn;
  const bufferP = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  doc.on('data', c => chunks.push(c));
  doc.on('end', () => resolveFn(Buffer.concat(chunks)));
  doc.on('error', rejectFn);

  // Header
  const logo = findLogoPath();
  if (logo) { try { doc.image(logo, { fit:[56,56], align:'left' }); } catch {} }
  doc.fontSize(18).text(clubName, logo ? 72 : 0, logo ? 54 : 18, { continued:false });
  doc.moveDown(logo ? 1.2 : 0.6);
  doc.fontSize(12).fillColor('#333').text('Competition Participation Confirmation');
  doc.moveDown(0.5);
  doc.moveTo(54, doc.y).lineTo(540, doc.y).strokeColor('#999').stroke();
  doc.moveDown(0.8);

  // Body
  const line = (label, value) => {
    doc.font('Helvetica-Bold').fillColor('#111').text(label + ': ', { continued:true });
    doc.font('Helvetica').fillColor('#111').text(String(value || ''));
  };

  line('Location', 'Belmont SSAA');
  line('Member Name', record.name || '');
  line('Member #', record.memberId || '');
  line('Competition date', compDate);
  line('Category', firearm);
  line('Class', record.klass || '');
  line('Competition', comp);
  if (record.licenceType || record.licenceNo) line('Licence', [record.licenceType, record.licenceNo].filter(Boolean).join(' '));
  line('Verified by Range Officer', roName);

  doc.moveDown(1.2);
  doc.fontSize(10).fillColor('#555').text('This PDF is generated by PRSC Check‑In. Keep it for your records.');

  doc.end();
  const buffer = await bufferP;
  const base = `PRSC_Confirmation_${dayTag(record.shootDate||new Date())}_${(record.memberId||'member').toString().replace(/[^A-Za-z0-9_-]+/g,'_')}.pdf`;
  return { buffer, filename: base };
}

function getTransport() {
  const p1 = path.join(app.getPath('userData'), 'email.json');
  const p2 = path.join(__dirname, 'email.json');
  const cfg = fs.existsSync(p1) ? JSON.parse(fs.readFileSync(p1,'utf8'))
           : fs.existsSync(p2) ? JSON.parse(fs.readFileSync(p2,'utf8'))
           : null;
  if (!cfg || !cfg.host) return { transporter: null, cfg: null };
  return {
    transporter: nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port ?? 587,
      secure: !!cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined
    }),
    cfg
  };
}

// ---------- Member email (PDF attach if SMTP) ----------
ipcMain.handle('sendMemberEmail', async (_evt, { to, record = {}, roName = 'Range Officer' } = {}) => {
  if (!to) return { ok:false, error:'missing-recipient' };
  const { subject, text } = buildMemberEmail(record, roName);
  const pdf = await buildMemberPdf(record, roName);
  const { transporter, cfg } = getTransport();

  if (transporter) {
    await transporter.sendMail({
      from: cfg.from || cfg.user || 'no-reply@prsci.org.au',
      to,
      subject,
      text,
      attachments: [{ filename: pdf.filename, content: pdf.buffer }]
    });
    return { ok:true, method:'smtp', attached: pdf.filename };
  }

  // Fallback: save PDF and open mailto
  const saveDir = path.join(app.getPath('documents'), 'PRSC', 'Confirmations', dayTag(record.shootDate||new Date()));
  fs.mkdirSync(saveDir, { recursive:true });
  const pdfPath = path.join(saveDir, pdf.filename);
  try { fs.writeFileSync(pdfPath, pdf.buffer); } catch {}
  try {
    await shell.openExternal(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text + "\n\nPDF saved at: " + pdfPath + "\n(Please attach it manually)")}`);
  } catch {}
  try { await shell.showItemInFolder(pdfPath); } catch {}
  return { ok:false, needsConfig:true, savedAs: pdf.filename, folder: saveDir };
});
ipcMain.handle('send-member-email', async (e, payload) => ipcMain.invoke('sendMemberEmail', payload));

// ---------- Append check-ins to a daily JSON ----------
const checkinsDir = path.join(app.getPath('userData'), 'checkins');
fs.mkdirSync(checkinsDir, { recursive: true });
function appendCheckinToDisk(row){
  const day = row.shootDate || dayTag();
  const file = path.join(checkinsDir, `checkins_${day}.json`);
  let arr = [];
  try { if (fs.existsSync(file)) arr = JSON.parse(fs.readFileSync(file,'utf8')); } catch {}
  arr.unshift(row);
  fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8');
  return file;
}
ipcMain.handle('appendCheckin', async (_e, row) => { try { return { ok:true, file: appendCheckinToDisk(row) }; } catch(e){ return { ok:false, error:e.message }; } });

// ---------- Finalise attendance (CSV + email) ----------
ipcMain.handle('finalize-participation', async (_evt, { checkins = [], exportsDir = '', to = 'admin@prsci.org.au', shootDate } = {}) => {
  if (!Array.isArray(checkins) || checkins.length === 0) return { ok:false, error:'no-rows' };
  const folder = exportsDir && fs.existsSync(exportsDir) ? exportsDir : (store.get('exportsDir') || path.join(app.getPath('documents'), 'PRSC', 'Participation'));
  fs.mkdirSync(folder, { recursive: true });
  const dateTag = shootDate || dayTag();
  const csvPath = path.join(folder, `PRSC_Participation_${dateTag}.csv`);
  const headers = ['timestamp','shootDate','memberId','name','firearm','klass','competition','participationType','licenceType','licenceNo','licenceVerified','verifiedBy'];
  const esc = (v) => '"' + String(v ?? '').replace(/"/g,'""') + '"';
  const csv = [headers.join(','), ...checkins.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
  fs.writeFileSync(csvPath, csv, 'utf8');

  const { transporter, cfg } = getTransport();
  if (transporter) {
    await transporter.sendMail({
      from: cfg.from || cfg.user || 'no-reply@prsci.org.au',
      to,
      subject: `PRSC Participation — ${dateTag}`,
      text: `Attached is the participation CSV for ${dateTag}.`,
      attachments: [{ filename: path.basename(csvPath), path: csvPath }]
    });
    return { ok:true, savedAs: path.basename(csvPath), folder, to, method:'smtp' };
  }
  const subject = `PRSC Participation — ${dateTag}`;
  const body = `File saved at: ${csvPath}\nPlease attach and send.`;
  try { await shell.openExternal(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`); } catch {}
  try { await shell.showItemInFolder(csvPath); } catch {}
  return { ok:false, needsConfig:true, savedAs: path.basename(csvPath), folder, to };
});
ipcMain.handle('email-attendance', async (e, payload) => ipcMain.invoke('finalize-participation', payload));

// ---------- Misc ----------
ipcMain.handle('setFullScreen', (_e, on) => { const w = BrowserWindow.getFocusedWindow(); if (w) w.setFullScreen(!!on); });
ipcMain.handle('ping', () => 'pong');