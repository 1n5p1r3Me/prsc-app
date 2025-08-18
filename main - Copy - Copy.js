// ===============================
// Save this first part as: main.js
// ===============================
// Electron main process for PRSC (clean, syntax‑checked)
// • Loads Vite dev UI (5173/5174/5175) or ui/dist/index.html
// • Access ODBC sync of FINANCIAL members
// • QR export
// • Exports/Participation folder memory (get/set/pick + kebab‑case aliases)
// • Finalise participation: SAVE CSV to chosen folder + EMAIL to admin
// • Member confirmation: generates a **PDF attachment** and emails it to the member (SMTP) or saves & opens folder (mailto fallback)
// • Back‑compat: get-saved-db-path, get-exports-dir, send-member-email, email-attendance
//
// Requires:  npm i odbc electron-store qrcode nodemailer pdfkit

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

let mainWindow;
function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Try Vite dev server first, then built UI
  (async () => {
    const ports = [5173, 5174, 5175];
    for (const p of ports) {
      try {
        await mainWindow.loadURL(`http://localhost:${p}`);
        return; // success
      } catch (e) {
        // keep trying next port
      }
    }
    // Fall back to built static files
    await mainWindow.loadFile(path.join(__dirname, 'ui', 'dist', 'index.html'));
  })();
}


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
  // Use aliases that are DIFFERENT to original column names to avoid Access error -3005
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

// ---------- Member email (now generates PDF confirmation) ----------
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

function getTransport() {
  // Optional email.json next to main.js or in userData can define SMTP
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

function findLogoPath() {
  const tryPaths = [
    path.join(__dirname, 'assets', 'prsc-logo.png'),
    path.join(__dirname, 'prsc-logo.png'),
    path.join(__dirname, 'ui', 'public', 'prsc-logo.png')
  ];
  return tryPaths.find(p => fs.existsSync(p)) || null;
}

// Create a confirmation PDF for a member and return its absolute path
function makeMemberPdf(record = {}, roName = 'Range Officer') {
  return new Promise((resolve, reject) => {
    try {
      const dateTag = dayTag(record.shootDate || new Date());
      const outDir = path.join(app.getPath('documents'), 'PRSC', 'Confirmations', dateTag);
      fs.mkdirSync(outDir, { recursive: true });
      const safe = (s) => String(s||'').replace(/[^A-Za-z0-9_.-]+/g, '_');
      const fname = `PRSC_Confirmation_${safe(record.memberId || 'member')}_${dateTag}.pdf`;
      const file = path.join(outDir, fname);

      const doc = new PDFDocument({ margin: 48 });
      const stream = fs.createWriteStream(file);
      doc.pipe(stream);

      // Header with optional logo
      const logo = findLogoPath();
      if (logo) {
        try { doc.image(logo, 48, 42, { width: 64 }); } catch {}
      }
      doc.fontSize(20).text('Pine Rivers Shooting Club', logo ? 120 : 48, 48);
      doc.moveDown(0.5);
      doc.fontSize(12).fillColor('#333').text('Competition Participation Confirmation');
      doc.moveDown(1.2);

      const line = (label, value) => {
        doc.font('Helvetica-Bold').fillColor('#000').text(label + ':', { continued: true });
        doc.font('Helvetica').fillColor('#000').text(' ' + (value || ''));
      };

      const fmtDMY = (d) => { try { const dt = new Date(d); return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`; } catch { return d || ''; } };
      const firearm = record.firearm === 'H' ? 'Pistol (H)' : 'Long arms (A/B)';
      const comp    = record.competition === 'SILHOUETTE' ? 'Metal Silhouette' : 'Target';

      line('Club', 'Pine Rivers Shooting Club');
      line('Location', 'Belmont SSAA');
      line('Member Name', record.name || '');
      line('Member #', record.memberId || '');
      line('Competition date', fmtDMY(record.shootDate));
      line('Category', firearm);
      line('Class', record.klass || '');
      line('Competition', comp);
      if (record.licenceType) line('Licence', [record.licenceType, record.licenceNo].filter(Boolean).join(' '));
      line('Verified by Range Officer', roName);

      doc.moveDown(1.2);
      doc.fontSize(10).fillColor('#444').text(`Generated: ${new Date().toLocaleString()}`);

      doc.end();
      stream.on('finish', () => resolve(file));
      stream.on('error', reject);
    } catch (e) { reject(e); }
  });
}

ipcMain.handle('sendMemberEmail', async (_evt, { to, record = {}, roName = 'Range Officer' } = {}) => {
  if (!to) return { ok:false, error:'missing-recipient' };

  // Always generate the PDF first
  const pdfPath = await makeMemberPdf(record, roName);
  const { subject, text } = buildMemberEmail(record, roName);
  const { transporter, cfg } = getTransport();

  if (transporter) {
    await transporter.sendMail({
      from: cfg.from || cfg.user || 'no-reply@prsci.org.au',
      to,
      subject,
      text,
      attachments: [
        { filename: path.basename(pdfPath), path: pdfPath, contentType: 'application/pdf' }
      ]
    });
    return { ok:true, method:'smtp', pdfPath };
  }

  // mailto fallback — cannot attach, so open mail client and reveal file
  await shell.openExternal(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text + "\n\n(Confirmation PDF saved at: " + pdfPath + ")")}`);
  try { await shell.showItemInFolder(pdfPath); } catch {}
  return { ok:false, needsConfig:true, pdfPath };
});
// alias for older UI
ipcMain.handle('send-member-email', async (e, payload) => ipcMain.invoke('sendMemberEmail', payload));

// ---------- Append check-ins to a daily JSON (simple local persistence) ----------
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

// ---------- Finalise attendance (save + email CSV for admin) ----------
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
  // mailto fallback — open new message and reveal the saved CSV
  const subject = `PRSC Participation — ${dateTag}`;
  const body = `File saved at: ${csvPath}\nPlease attach and send.`;
  try { await shell.openExternal(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`); } catch {}
  try { await shell.showItemInFolder(csvPath); } catch {}
  return { ok:false, needsConfig:true, savedAs: path.basename(csvPath), folder, to };
});
// Legacy alias (email‑only builds will still work)
ipcMain.handle('email-attendance', async (e, payload) => ipcMain.invoke('finalize-participation', payload));

// ---------- Misc ----------
ipcMain.handle('setFullScreen', (_e, on) => { const w = BrowserWindow.getFocusedWindow(); if (w) w.setFullScreen(!!on); });
ipcMain.handle('ping', () => 'pong');


