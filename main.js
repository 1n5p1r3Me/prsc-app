// ===============================
// main.js — PRSC Electron Main (icon‑ready)
// Version bump to v1.0.9
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
// --- Auto‑update ---
const { autoUpdater } = require('electron-updater');
const log = require('electron-log'); // you already depend on this

// --- Force unified userData folder (dev + prod) ---
const appLabel = 'PRSC Check-In';
app.setName(appLabel);  // ensures app.getName() matches productName
app.setPath('userData', path.join(app.getPath('appData'), appLabel));
// Optional: move volatile caches to %TEMP% so they don't clutter Roaming
app.setPath('cache', path.join(app.getPath('temp'), `${appLabel}-Cache`));

// ---------- Store ----------
// ---------- Store ----------
const store = new Store({
  name: 'prsc-settings',
  defaults: { accdbPath: '', exportsDir: '' }
});

// Ensure the settings file exists + show where it's going
const settingsPath = path.join(app.getPath('userData'), 'prsc-settings.json');
console.log('[PRSC] userData dir:', app.getPath('userData'));
console.log('[PRSC] electron-store file:', (store && store.path) || settingsPath);

try {
  if (!fs.existsSync(settingsPath)) {
    // 1) force first write (electron-store creates the file on set)
    store.set('__init', new Date().toISOString());
    // 2) hard fallback (belt-and-braces) — writes a minimal file if still missing
    if (!fs.existsSync(settingsPath)) {
      fs.writeFileSync(settingsPath, JSON.stringify(store.store ?? {}, null, 2), 'utf8');
      console.log('[PRSC] wrote fallback settings to', settingsPath);
    }
  }
} catch (e) {
  console.error('[PRSC] ensure settings failed:', e);
}


// ---------- Helpers ----------
const b = (name) => `[${String(name).replace(/]/g, ']]')}]`; // Access bracket escape
const isTrue = (v) => (v === true || v === 1 || v === -1 || String(v ?? '').toLowerCase() === 'true' || String(v ?? '').toLowerCase() === 'yes');
const dayTag = (d = new Date()) => new Date(d).toISOString().slice(0,10);
// Configure autoUpdater logging & feed
log.transports.file.level = 'info';
autoUpdater.logger = log;

// Optional: don’t spam update checks in dev
const checkUpdatesSafe = () => {
  if (!app.isPackaged) {
    log.info('[autoUpdater] Skipping (not packaged)');
    return;
  }
  try {
    autoUpdater.checkForUpdatesAndNotify();
  } catch (e) {
    log.error('[autoUpdater] check failed', e);
  }
};

// Useful diagnostics
autoUpdater.on('error', (err) => log.error('[autoUpdater] error', err));
autoUpdater.on('checking-for-update', () => log.info('[autoUpdater] checking-for-update'));
autoUpdater.on('update-available', (info) => log.info('[autoUpdater] update-available', info));
autoUpdater.on('update-not-available', (info) => log.info('[autoUpdater] update-not-available', info));
autoUpdater.on('download-progress', (p) => log.info('[autoUpdater] download-progress', p));
autoUpdater.on('update-downloaded', (info) => {
  log.info('[autoUpdater] update-downloaded; will install on quit]');
  // autoUpdater.quitAndInstall(); // if you want immediate apply; I’m leaving notify-only behavior
});

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
setTimeout(checkUpdatesSafe, 1500);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
});


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
  const fmtDMY = (d) => {
    try {
      const dt = new Date(d);
      return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`;
    } catch { return d || ''; }
  };

  // keep on one line so it never splits
  const firearm = record.firearm === 'H' ? 'Pistol (H)' : 'Longarms (A/B)';

  const subject = `Competition Participation for ${firearm} ${record.klass || ''} — ${fmtDMY(record.shootDate)}`;

  // <-- exactly the three lines you showed, joined into a string
  const text = [
    `Thank you for participating in the PRSC competition.`,
    `Location: Belmont SSAA`,
    `Competition date: ${fmtDMY(record.shootDate)}`
  ].join('\n');

  return { subject, text };
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
  const firearm = record.firearm === 'H' ? 'Pistol (H)' : 'Longarms (A/B)';
  // before: const comp = record.competition === 'SILHOUETTE' ? 'Metal Silhouette' : 'Target';
const compMap = {
  TARGET: 'Target',
  SILHOUETTE: 'Metal Silhouette',
  WESTERN: 'Western Action',
};
const comp = compMap[record.competition] || (record.competition || '');


  const compDate = fmtDMY(record.shootDate);

  const doc = new PDFDocument({ size: 'A4', margin: 54 });
  const chunks = []; let resolveFn, rejectFn;
  const bufferP = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  doc.on('data', c => chunks.push(c));
  doc.on('end', () => resolveFn(Buffer.concat(chunks)));
  doc.on('error', rejectFn);

  // Header — centered logo at top, reserve space, no duplicate club name
  const logo = findLogoPath();

  // ensure we start at the very top margin
  doc.y = doc.page.margins.top;

  if (logo) {
    const contentW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const maxW = 220;   // tweak to taste (e.g., 180–260)
    const maxH = 110;   // vertical space reserved for the logo box
    const x = doc.page.margins.left + (contentW - maxW) / 2;
    const y = doc.y;

    // draw logo centered within a fixed box; it won't exceed maxW × maxH
    try { doc.image(logo, x, y, { fit: [maxW, maxH] }); } catch {}

    // move the cursor below the reserved image area + a small buffer
    doc.y = y + maxH + 20;
  }

  // Subtitle — right aligned & bold
  doc.moveDown(0.2);
  doc.font('Helvetica-Bold')
     .fontSize(14)
     .fillColor('#111')
     .text('Competition Participation Confirmation', doc.page.margins.left, doc.y);

  // Rule across the full content width
  doc.moveDown(0.4);
  doc.moveTo(doc.page.margins.left, doc.y)
     .lineTo(doc.page.width - doc.page.margins.right, doc.y)
     .strokeColor('#999')
     .stroke();
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

  // NEW: If F33 was ticked, include it above the "Verified by" line
  if (record.f33 === 'Y' || record.f33 === true) {
    line('F33', 'verified');
  }
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
ipcMain.handle('finalize-participation', async (_evt, {
  checkins = [],
  exportsDir = '',
  to = 'admin@prsci.org.au',
  shootDate,
  safetyBrief = {}           // <-- NEW
} = {}) => {
  if (!Array.isArray(checkins) || checkins.length === 0) return { ok:false, error:'no-rows' };

  // NEW: enforce Safety Brief presence (belt-and-braces validation)
  const deliveredOk = safetyBrief && (safetyBrief.deliveredById || safetyBrief.deliveredByName);
  const verifiedOk  = safetyBrief && (safetyBrief.verifiedById  || safetyBrief.verifiedByName);
  if (!deliveredOk || !verifiedOk) {
    return { ok:false, error:'missing-safety-brief' };
  }

  const folder = exportsDir && fs.existsSync(exportsDir) ? exportsDir : (store.get('exportsDir') || path.join(app.getPath('documents'), 'PRSC', 'Participation'));
  fs.mkdirSync(folder, { recursive: true });
  const dateTag = shootDate || dayTag();
  const csvPath = path.join(folder, `PRSC_Participation_${dateTag}.csv`);

  // NEW: add 'f33' column (Y if verified, else blank) + Safety Brief columns
  const headers = [
    'timestamp','shootDate','memberId','name','Category','class','competition','participationType',
    'licenceType','licenceNo','licenceVerified','verifiedBy','f33',
    'safetyDeliveredBy','safetyVerifiedBy',
  ];
  const esc = (v) => '"' + String(v ?? '').replace(/"/g,'""') + '"';
  const csv = [
    headers.join(','),
    ...checkins.map(r => headers.map(h => {
      switch (h) {
        case 'safetyDeliveredBy':   return esc(safetyBrief.deliveredByName || '');
        case 'safetyVerifiedBy':    return esc(safetyBrief.verifiedByName || '');
        case 'class':               return esc(r.klass || ''); // <-- map header 'class' to data 'klass'
        case 'Category':          return esc(r.firearm || ''); // NEW mapping
        default:                    return esc(r[h]);
      }
    }).join(','))
  ].join('\n');
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
