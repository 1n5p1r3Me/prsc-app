import React, { useEffect, useMemo, useState } from 'react';

/**
 * PRSC – Range Check-In UI (React + Vite) rendered inside Electron
 *
 * Includes:
 *  - Kiosk: Admin never shows in kiosk; unlock paths respect kiosk
 *  - Scanner: parse on Enter before touching state (no raw "00:00:00|financial|..." flash)
 *  - Member ID pattern: 3–4 digits, optional "-NN" (e.g., 123, 0456, 123-01)
 *  - Licence pattern: optional short alpha prefix + 6–10 digits (e.g., QLD1234567 or 1234567)
 *  - Clear previous member after save + short kiosk success toast
 */

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '');
const isTrue = (v) =>
  v === true ||
  v === 1 ||
  v === -1 ||
  String(v ?? '').toLowerCase() === 'true' ||
  String(v ?? '').toLowerCase() === 'yes';

export default function App() {
  // --- Admin / Data ---
  const [members, setMembers] = useState([]);
  const [msg, setMsg] = useState('');

  // --- Lock / RO identity ---
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [roMember, setRoMember] = useState(null);
  const [pin] = useState('1234');
  const [pinInput, setPinInput] = useState('');
  const [roPick, setRoPick] = useState('');
  const [roName, setRoName] = useState('');

  // --- Kiosk/Admin ---
  const [kiosk, setKiosk] = useState(false);
  const [adminUnlocked, setAdminUnlocked] = useState(true);

  // --- Check-in form ---
  const [current, setCurrent] = useState({ memberId: '', fullName: '', email: '', licenceNo: '' });
  const [firearm, setFirearm] = useState('');
  const [klass, setKlass] = useState('');
  const [comp, setComp] = useState('');
  const [shootDate, setShootDate] = useState(new Date().toISOString().slice(0, 10));
  const [partType, setPartType] = useState('');
  const [idType, setIdType] = useState('');
  const [licNo, setLicNo] = useState('');

  // Verify step
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifiedChecked, setVerifiedChecked] = useState(false);
  const [pendingRow, setPendingRow] = useState(null);
  const [verifierId, setVerifierId] = useState('');
  const [verifierNameManual, setVerifierNameManual] = useState('');

  // Recent check-ins
  const [checkins, setCheckins] = useState([]);

  // Exports folder
  const [exportsDir, setExportsDir] = useState('');

  // Electron bridge
  const bridge = useMemo(() => (window?.electronAPI || {}), []);

  // RO list
  const roList = useMemo(
    () => (members || []).filter((m) => isTrue(m.isRO ?? m.IsRO ?? m.isRo ?? m.ro ?? m.is_range_officer)),
    [members]
  );

  // Load saved settings + members
  useEffect(() => {
    (async () => {
      try {
        if (bridge.getSavedDbPath && bridge.fetchMembers) {
          const p = await bridge.getSavedDbPath();
          if (p) {
            const rows = await bridge.fetchMembers();
            setMembers(rows || []);
            const roCount = (rows || []).filter((r) => isTrue(r.isRO)).length;
            setMsg(`Synced ${rows?.length || 0} financial members (${roCount} ROs).`);
          }
        }
        if (bridge.getExportsDir) {
          const d = await bridge.getExportsDir();
          const path = typeof d === 'string' ? d : d?.folder || '';
          if (path) setExportsDir(path);
        }
      } catch (e) {
        console.error(e);
      }
    })();
  }, [bridge]);

  // Admin actions
  async function chooseDb() {
    if (!bridge.pickAccessFile) {
      setMsg('This button works inside Electron.');
      return;
    }
    const p = await bridge.pickAccessFile();
    if (p && bridge.fetchMembers) {
      setMsg('Syncing…');
      const rows = await bridge.fetchMembers();
      setMembers(rows || []);
      const roCount = (rows || []).filter((r) => isTrue(r.isRO)).length;
      setMsg(`Synced ${rows?.length || 0} financial members (${roCount} ROs).`);
    }
  }
  async function syncFinancial() {
    if (!bridge.fetchMembers) {
      setMsg('ODBC sync is only available inside Electron.');
      return;
    }
    try {
      setMsg('Syncing…');
      const rows = await bridge.fetchMembers();
      setMembers(rows || []);
      const roCount = (rows || []).filter((r) => isTrue(r.isRO)).length;
      setMsg(`Synced ${rows?.length || 0} financial members (${roCount} ROs).`);
    } catch (e) {
      console.error(e);
      setMsg('Sync failed (check Access driver & file path).');
    }
  }
  async function exportQRCodesToFolder() {
    if (!members?.length) {
      setMsg('No members to export.');
      return;
    }
    if (!bridge.exportQrPngs) {
      setMsg('Update Electron main/preload to support QR export.');
      return;
    }
    try {
      const res = await bridge.exportQrPngs(members);
      if (res?.ok) setMsg(`Saved ${res.count} QR codes to ${res.folder}`);
      else setMsg(res?.error || 'QR export failed');
    } catch (e) {
      console.error(e);
      setMsg('QR export failed');
    }
  }
  async function finalizeParticipation() {
    if (!checkins?.length) {
      setMsg('No check-ins to finalise yet.');
      return;
    }
    try {
      if (bridge.finalizeParticipation) {
        const res = await bridge.finalizeParticipation({
          checkins,
          exportsDir,
          to: 'admin@prsci.org.au',
          shootDate,
        });
        if (res?.ok) {
          setMsg(`Saved ${res.savedAs || 'workbook'} to ${res.folder || exportsDir} and emailed to ${res.to || 'admin@prsci.org.au'}.`);
        } else {
          setMsg(res?.error || 'Finalisation failed.');
        }
        return;
      }
      if (bridge.emailAttendance) {
        const res = await bridge.emailAttendance({ to: 'admin@prsci.org.au', checkins, exportsDir, shootDate });
        if (res?.ok) setMsg('Attendance emailed (saving requires an updated main.js).');
        else setMsg(res?.error || 'Email failed');
      } else {
        setMsg('This build does not support emailing/saving yet.');
      }
    } catch (e) {
      console.error(e);
      setMsg('Finalisation failed.');
    }
  }
  async function pickExportsFolder() {
    try {
      const d = bridge.pickExportsDir
        ? await bridge.pickExportsDir()
        : bridge.setExportsDir
        ? await bridge.setExportsDir()
        : bridge.pickSaveFolder
        ? await bridge.pickSaveFolder()
        : bridge.pickFolder
        ? await bridge.pickFolder()
        : null;

      const path = typeof d === 'string' ? d : d?.folder || '';
      if (path) {
        setExportsDir(path);
        setMsg(`Saving documents to: ${path}`);
      } else if (d?.error) {
        setMsg(d.error);
      } else {
        setMsg('No folder selected.');
      }
    } catch (e) {
      console.error(e);
      setMsg('Could not choose folder.');
    }
  }

  // Admin "use member"
  function onPickMember(m) {
    setCurrent({ memberId: m.memberId, fullName: m.fullName, email: m.email || '', licenceNo: m.licenceNo || '' });
    setLicNo(m.licenceNo || '');
    setPartType('COMP');
  }

  // Auto-fill from typed/scanned ID once current.memberId changes
  useEffect(() => {
    const id = String(current.memberId || '').trim();
    if (!id) return;
    const match = members.find((m) => String(m.memberId || '').trim() === id);
    if (match) {
      setCurrent((s) => ({ ...s, fullName: match.fullName || '', email: match.email || '' }));
      setLicNo(match.licenceNo || '');
      setPartType('COMP');
    }
  }, [current.memberId, members]);

  // Scanner: buffer keys, on Enter parse *before* updating state
  useEffect(() => {
    let buf = '';
    let last = 0;

    function onKey(e) {
      const now = Date.now();
      if (now - last > 80) buf = '';
      last = now;

      if (e.key === 'Enter') {
        const raw = buf;
        buf = '';
        const text = (raw || '').trim();
        if (!text) return;

        // ----- UNLOCK PATHS -----
        // Remove leading timestamp like "00:00:00|"
        const cleaned = text.replace(/^\d{2}:\d{2}:\d{2}\|/, '');

        // 1) Existing PRSC payload (now also requires isCurrent)
        if (!isUnlocked && cleaned.startsWith('PRSC|')) {
          const [, memberId] = cleaned.split('|');
          const m = members.find((x) => String(x.memberId) === String(memberId));
          if (m && isTrue(m.isRO) && isTrue(m.isCurrent)) {
            setRoMember({ memberId: m.memberId, fullName: m.fullName });
            setIsUnlocked(true);
            setAdminUnlocked(!kiosk); // keep admin hidden in kiosk
            setMsg(`Unlocked by RO ${m.fullName}`);
            return;
          }
          setMsg('Only a current Range Officer can unlock.');
          return;
        }

        // 2) NEW: Bare Member ID QR unlock (e.g., "1234" or "0456-01"); requires isCurrent + isRO
        if (!isUnlocked) {
          const memberIdPattern = /^\d{3,4}(?:-\d{2})?$/; // 3–4 digits, optional "-NN"
          if (memberIdPattern.test(cleaned)) {
            const memberId = cleaned;
            const m = members.find((x) => String(x.memberId) === String(memberId));
            if (m && isTrue(m.isRO) && isTrue(m.isCurrent)) {
              setRoMember({ memberId: m.memberId, fullName: m.fullName });
              setIsUnlocked(true);
              setAdminUnlocked(!kiosk);
              setMsg(`Unlocked by RO ${m.fullName}`);
              return;
            }
            setMsg('Only a current Range Officer can unlock.');
            return;
          }
        }
        // ----- END UNLOCK PATHS -----

        // Primary formats for check-in scanning (when unlocked)
        // “PRSC|...” member card
        if (cleaned.startsWith('PRSC|')) {
          const parts = cleaned.split('|');
          const memberId = parts[1] || '';
          const fullName = parts[2] || '';
          const licenceNoScanned = parts[5] || '';

          const m = members.find((x) => String(x.memberId) === String(memberId));
          if (m) {
            setCurrent({
              memberId,
              fullName: m.fullName || fullName,
              email: m.email || '',
              licenceNo: m.licenceNo || licenceNoScanned,
            });
            setLicNo(m.licenceNo || licenceNoScanned);
          } else {
            setCurrent({ memberId, fullName, email: '', licenceNo: licenceNoScanned });
            setLicNo(licenceNoScanned);
          }
          setPartType('COMP');
          setMsg(`Scanned ${memberId}${fullName ? ` (${fullName})` : ''}`);
          return;
        }

        // “financial|<memberId>” fallback
        const finMatch = cleaned.match(/(?:^|[|])financial\|([A-Za-z0-9-]+)$/i);
        if (finMatch) {
          const memberId = finMatch[1];
          const m = members.find((x) => String(x.memberId) === String(memberId));
          if (m) {
            setCurrent({ memberId, fullName: m.fullName || '', email: m.email || '', licenceNo: m.licenceNo || '' });
            setLicNo(m.licenceNo || '');
          } else {
            setCurrent({ memberId, fullName: '', email: '', licenceNo: '' });
            setLicNo('');
          }
          setPartType('COMP');
          setMsg(`Scanned ${memberId}`);
          return;
        }

        // ---- Heuristics for fallback: licence vs member ID ----
        const trimmed = cleaned.trim();
        const licencePattern = /^(?:[A-Z]{2,4}\s*)?\d{6,10}$/i;     // optional alpha + 6–10 digits
        const memberIdPattern = /^\d{3,4}(?:-\d{2})?$/;             // 3–4 digits, optional "-NN"

        if (licencePattern.test(trimmed)) {
          setLicNo(trimmed);
          setCurrent((s) => ({ ...s })); // don't touch memberId
          setMsg('Licence/ID captured');
          return;
        }

        if (memberIdPattern.test(trimmed)) {
          const memberId = trimmed;
          const m = members.find((x) => String(x.memberId) === String(memberId));
          if (m) {
            setCurrent({ memberId, fullName: m.fullName || '', email: m.email || '', licenceNo: m.licenceNo || '' });
            setLicNo(m.licenceNo || '');
          } else {
            setCurrent({ memberId, fullName: '', email: '', licenceNo: '' });
            setLicNo('');
          }
          setPartType('COMP');
          setMsg(`Scanned ${memberId}`);
          return;
        }

        // Last resort: try safe chars as ID; otherwise, ignore
        const fallbackId = trimmed.replace(/[^A-Za-z0-9-]/g, '');
        if (fallbackId) {
          const m = members.find((x) => String(x.memberId) === String(fallbackId));
          if (m) {
            setCurrent({ memberId: fallbackId, fullName: m.fullName || '', email: m.email || '', licenceNo: m.licenceNo || '' });
            setLicNo(m.licenceNo || '');
            setPartType('COMP');
            setMsg(`Scanned ${fallbackId}`);
          } else {
            setMsg('Scan not recognised as PRSC ID or licence');
          }
        }
        return;
      }

      if (e.key.length === 1) buf += e.key;
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isUnlocked, members, kiosk]);

  // ---- Two-step verify flow ----
  function startCheckin() {
    if (!isUnlocked) {
      setMsg('Please unlock by Range Officer (scan RO card or enter PIN).');
      return;
    }
    if (!current.memberId || !firearm || !klass || !comp || !partType) {
      setMsg('Please fill member + all fields (including Participation Type).');
      return;
    }
    if (partType === 'VISITOR' && !idType.trim()) {
      setMsg('Please enter the visitor ID type/number.');
      return;
    }

    const row = {
      timestamp: new Date().toISOString(),
      shootDate,
      memberId: current.memberId,
      name: current.fullName,
      firearm,
      klass,
      competition: comp,
      participationType: partType,
      licenceType: partType === 'VISITOR' ? 'ID' : licNo ? 'licensed' : '',
      licenceNo: partType === 'VISITOR' ? idType : licNo || current.licenceNo || '',
      licenceVerified: false,
      verifiedBy: '',
    };

    const defaultVerifier = roList.find((ro) => String(ro.memberId) !== String(row.memberId));
    setVerifierId(defaultVerifier ? String(defaultVerifier.memberId) : '');
    setVerifierNameManual('');
    setPendingRow(row);
    setVerifiedChecked(false);
    setVerifyOpen(true);
  }

  async function confirmVerifyAndSave() {
    if (!pendingRow) return;

    let verifierFullName = '';

    if (roList.length > 0) {
      const verifier = roList.find((r) => String(r.memberId) === String(verifierId));
      if (!verifier) {
        setMsg('Please select a Range Officer to verify.');
        return;
      }
      if (String(verifier.memberId) === String(pendingRow.memberId)) {
        setMsg('An RO cannot verify their own check-in. Please pick another RO.');
        return;
      }
      verifierFullName = verifier.fullName;
    } else {
      if (!verifierNameManual.trim()) {
        setMsg('Enter the verifying RO name.');
        return;
      }
      verifierFullName = verifierNameManual.trim();
    }

    const mustTick = !!pendingRow.licenceType;
    if (mustTick && !verifiedChecked) {
      setMsg('Please tick “Licence/ID verified”.');
      return;
    }

    const final = {
      ...pendingRow,
      licenceVerified: mustTick ? !!verifiedChecked : false,
      verifiedBy: verifierFullName,
    };

    setCheckins((prev) => [final, ...prev]);
    try {
      bridge.appendCheckin && (await bridge.appendCheckin(final));
    } catch {}

    try {
      if (current.email && bridge.sendMemberEmail) {
        await bridge.sendMemberEmail({
          to: current.email,
          record: final,
          roName: verifierFullName,
          location: 'Pine Rivers Shooting Club',
        });
        setMsg(`Check-in saved and emailed to ${current.email}`);
      } else {
        setMsg('Check-in saved (no email on file).');
      }
    } catch (e) {
      console.error(e);
      setMsg('Check-in saved (email send failed).');
    }

    // reset for next person
    setFirearm('');
    setKlass('');
    setComp('');
    setPartType('');
    setIdType('');
    setVerifyOpen(false);
    setPendingRow(null);
    setVerifiedChecked(false);
    setVerifierId('');
    setVerifierNameManual('');
    setCurrent({ memberId: '', fullName: '', email: '', licenceNo: '' });

    if (kiosk) {
      setMsg('Checked in! Ready for the next person.');
      setTimeout(() => setMsg(''), 2500);
    }
  }

  // Kiosk helpers
  function toggleKiosk() {
    if (!kiosk) setAdminUnlocked(false);
    setKiosk((v) => !v);
    try {
      bridge.setFullScreen && bridge.setFullScreen(!kiosk);
    } catch {}
  }

  // Hard rule: Admin never shows in kiosk
  const showAdmin = isUnlocked && !kiosk;

  // If kiosk toggles on, keep admin off
  useEffect(() => {
    if (kiosk) setAdminUnlocked(false);
  }, [kiosk]);

  // ----- LOCK SCREEN -----
  if (!isUnlocked) {
    return (
      <div
        style={{
          fontFamily: 'system-ui, Arial',
          minHeight: '100vh',
          background: '#0b3d0b',
          color: '#fff',
          display: 'grid',
          placeItems: 'center',
          padding: 16,
        }}
      >
        <div
          style={{
            background: '#fff',
            color: '#111',
            padding: 24,
            borderRadius: 12,
            width: 560,
            boxShadow: '0 20px 40px rgba(0,0,0,.3)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <img src="/prsc-logo.png" alt="PRSC logo" style={{ height: 48 }} />
            <div>
              <div style={{ fontWeight: 700, fontSize: 18 }}>Pine Rivers Shooting Club</div>
              <div style={{ opacity: 0.8, fontSize: 12 }}>Range Check-In — Locked</div>
            </div>
          </div>

          <ol style={{ margin: '0 0 16px 18px', padding: 0, lineHeight: 1.6 }}>
            <li>
              <b>Range Officer scan</b>: present RO membership QR to unlock.
            </li>
            <li>
              or <b>PIN</b>: enter PIN and select your RO name, then Unlock.
            </li>
          </ol>

          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ fontSize: 13, color: '#444' }}>Unlock with PIN</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8 }}>
              <input value={pinInput} onChange={(e) => setPinInput(e.target.value)} placeholder="PIN" type="password" style={input} />
              {roList.length > 0 ? (
                <select value={roPick} onChange={(e) => setRoPick(e.target.value)} style={input}>
                  <option value="">Select Range Officer…</option>
                  {roList.map((m) => (
                    <option key={m.memberId} value={m.memberId}>
                      {m.fullName} ({m.memberId})
                    </option>
                  ))}
                </select>
              ) : (
                <input value={roName} onChange={(e) => setRoName(e.target.value)} placeholder="Type RO name (first-time unlock)" style={input} />
              )}
              <button
                onClick={() => {
                  if (pinInput !== pin) {
                    setMsg('Incorrect PIN');
                    return;
                  }
                  if (roList.length === 0) {
                    if (!roName.trim()) {
                      setMsg('Enter Range Officer name.');
                      return;
                    }
                    setRoMember({ memberId: '', fullName: roName.trim() });
                    setIsUnlocked(true);
                    setAdminUnlocked(!kiosk);
                    setMsg('Unlocked (first-time). Please choose DB and sync members.');
                    return;
                  }
                  const m = members.find((x) => String(x.memberId) === String(roPick) && isTrue(x.isRO));
                  if (!m) {
                    setMsg('Please select a Range Officer from the list.');
                    return;
                  }
                  setRoMember({ memberId: m.memberId, fullName: m.fullName });
                  setIsUnlocked(true);
                  setAdminUnlocked(!kiosk);
                  setMsg(`Unlocked by RO ${m.fullName}`);
                }}
                style={{ ...btn, background: '#166534', color: '#fff' }}
              >
                Unlock
              </button>
            </div>
          </div>

          {msg && (
            <div style={{ marginTop: 12, background: '#fff7ed', color: '#7c2d12', padding: 8, borderRadius: 8, fontSize: 12 }}>{msg}</div>
          )}
          <div style={{ marginTop: 10, fontSize: 12, color: '#555' }}>
            Tip: You can also just scan your RO card now — the app listens for QR/barcodes.
          </div>
        </div>
      </div>
    );
  }

  // ----- MAIN APP -----
  return (
    <div style={{ fontFamily: 'system-ui, Arial, sans-serif', background: '#f4f6f8', minHeight: '100vh', color: '#111' }}>
      <header
        style={{
          background: '#1b5e20',
          color: '#fff',
          padding: '12px 16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src="/prsc-logo.png" alt="PRSC logo" style={{ height: 48, width: 'auto' }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 18 }}>Pine Rivers Shooting Club</div>
            <div style={{ opacity: 0.9, fontSize: 12 }}>Range Check-In</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 13 }}>
            RO: <b>{roMember?.fullName || '—'}</b>
          </div>
          <button onClick={toggleKiosk} style={{ ...btn, background: '#0ea5e9', color: '#fff' }}>
            {kiosk ? 'Exit Kiosk' : 'Enter Kiosk'}
          </button>
        </div>
      </header>

      <main
        style={{
          maxWidth: 1200,
          margin: '16px auto',
          padding: '0 16px',
          display: 'grid',
          gridTemplateColumns: showAdmin ? '1fr 1fr' : '1fr',
          gap: 16,
        }}
      >
        {/* Admin */}
        {showAdmin && (
          <section style={{ background: '#fff', color: '#111', borderRadius: 12, boxShadow: '0 6px 18px rgba(0,0,0,0.06)', padding: 16 }}>
            <h2 style={{ margin: '4px 0 8px 0' }}>Admin</h2>
            <div style={{ fontSize: 12, color: '#444', marginBottom: 8 }}>
              Unlocked by <b>{roMember?.fullName}</b>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              <button onClick={chooseDb} style={btn}>Choose Database</button>
              <button onClick={syncFinancial} style={{ ...btn, background: '#166534', color: '#fff' }}>Sync financial members</button>
              <button onClick={exportQRCodesToFolder} style={btn}>QR codes</button>
              <button onClick={finalizeParticipation} style={btn}>Participation Finalisation</button>
              <button onClick={pickExportsFolder} style={btn}>Choose Participation folder</button>
            </div>
            {exportsDir && (
              <div style={{ fontSize: 12, color: '#444', margin: '-6px 0 8px 0' }}>
                Saving to: <b>{exportsDir}</b>
              </div>
            )}

            {msg && <div style={{ background: '#fff7ed', color: '#7c2d12', padding: 8, borderRadius: 8, fontSize: 12 }}>{msg}</div>}

            <div style={{ marginTop: 12, maxHeight: 320, overflow: 'auto', border: '1px solid #eee', borderRadius: 8 }}>
              <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse', color: '#111' }}>
                <thead style={{ position: 'sticky', top: 0, background: '#fafafa', color: '#111' }}>
                  <tr>
                    <th style={th}>Member</th>
                    <th style={th}>Email</th>
                    <th style={th}>Licence</th>
                    <th style={th}>Joined</th>
                    <th style={th}>RO?</th>
                    <th style={th}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {members.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ padding: 10, color: '#444' }}>No members (sync to load).</td>
                    </tr>
                  ) : (
                    members.map((m) => (
                      <tr key={m.memberId}>
                        <td style={td}>{m.fullName} <span style={{ color: '#555' }}>({m.memberId})</span></td>
                        <td style={td}>{m.email || ''}</td>
                        <td style={td}>{m.licenceNo || ''}</td>
                        <td style={td}>{fmtDate(m.joinDate)}</td>
                        <td style={td}>{isTrue(m.isRO) ? 'Yes' : ''}</td>
                        <td style={td}>
                          <button style={miniBtn} onClick={() => onPickMember(m)}>Use in check-in</button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Check-In */}
        <section style={{ background: '#fff', borderRadius: 12, boxShadow: '0 6px 18px rgba(0,0,0,0.06)', padding: 16 }}>
          <h2 style={{ margin: '4px 0 8px 0' }}>Range Check-In</h2>
          <div style={{ fontSize: 13, color: '#555', marginBottom: 10 }}>
            {showAdmin
              ? 'Pick a member from the left list, or fill manually:'
              : 'Enter your membership number (fields will auto-fill if found), or fill manually:'}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: showAdmin ? '1fr 1fr' : '1fr', gap: 10 }}>
            <label style={label}>
              Member ID
              <input value={current.memberId} onChange={(e) => setCurrent((s) => ({ ...s, memberId: e.target.value }))} style={input} />
            </label>
            <label style={label}>
              Full name
              <input value={current.fullName} onChange={(e) => setCurrent((s) => ({ ...s, fullName: e.target.value }))} style={input} />
            </label>
            <label style={label}>
              Email
              <input value={current.email} onChange={(e) => setCurrent((s) => ({ ...s, email: e.target.value }))} style={input} />
            </label>
            <label style={label}>
              Licence number
              <input value={licNo} onChange={(e) => setLicNo(e.target.value)} style={input} placeholder="if licensed" />
            </label>
            <label style={label}>
              Firearm today
              <select value={firearm} onChange={(e) => setFirearm(e.target.value)} style={input}>
                <option value="">Select…</option>
                <option value="H">Pistol – Category H</option>
                <option value="AB">Long arms – Category A/B</option>
              </select>
            </label>
            <label style={label}>
              Class (A/B/C/D)
              <select value={klass} onChange={(e) => setKlass(e.target.value)} style={input}>
                <option value="">Select…</option>
                <option value="A">A – Air</option>
                <option value="B">B – Centrefire ≤ .38 & black powder</option>
                <option value="C">C – Centrefire &gt; .38 &amp; &lt; .45</option>
                <option value="D">D – Rimfire</option>
              </select>
            </label>
            <label style={label}>
              Competition
              <select value={comp} onChange={(e) => setComp(e.target.value)} style={input}>
                <option value="">Select…</option>
                <option value="TARGET">Target</option>
                <option value="SILHOUETTE">Metal Silhouette</option>
              </select>
            </label>
            <label style={label}>
              Competition date
              <input type="date" value={shootDate} onChange={(e) => setShootDate(e.target.value)} style={input} />
            </label>
            <label style={label}>
              Participation Type
              <select value={partType} onChange={(e) => setPartType(e.target.value)} style={input}>
                <option value="">Select…</option>
                <option value="RO">Range officer</option>
                <option value="COMP">Competition</option>
                <option value="VISITOR">Visitor</option>
                <option value="SPECTATOR">Spectator</option>
              </select>
            </label>
            {partType === 'VISITOR' && (
              <label style={label}>
                ID type/number (required for visitors)
                <input
                  type="text"
                  value={idType}
                  onChange={(e) => setIdType(e.target.value)}
                  style={input}
                  placeholder="e.g., Driver licence QLD 1234567"
                />
              </label>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={startCheckin} style={{ ...btn, background: '#166534', color: '#fff' }}>Check-In</button>
          </div>

          {/* Verify panel */}
          {verifyOpen && pendingRow && (
            <div style={{ marginTop: 12, border: '1px solid #ddd', borderRadius: 8, padding: 12, background: '#f9fafb' }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Range Officer Verification</div>
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                Member: <b>{pendingRow.name}</b> ({pendingRow.memberId}) • Participation: {pendingRow.participationType} • Firearm{' '}
                {pendingRow.firearm === 'H' ? 'Pistol (H)' : 'Long arms (A/B)'} • Class {pendingRow.klass} • Competition {pendingRow.competition} • Date {pendingRow.shootDate}
              </div>

              {roList.length > 0 ? (
                <label style={{ display: 'grid', gap: 6, marginBottom: 8, fontSize: 13 }}>
                  <span>Verified by Range Officer</span>
                  <select value={verifierId} onChange={(e) => setVerifierId(e.target.value)} style={{ ...input }}>
                    <option value="">Select Range Officer…</option>
                    {roList.map((ro) => (
                      <option key={ro.memberId} value={ro.memberId} disabled={String(ro.memberId) === String(pendingRow.memberId)}>
                        {ro.fullName} ({ro.memberId})
                        {String(ro.memberId) === String(pendingRow.memberId) ? ' — cannot verify self' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label style={{ display: 'grid', gap: 6, marginBottom: 8, fontSize: 13 }}>
                  <span>Verified by Range Officer (type name)</span>
                  <input
                    type="text"
                    value={verifierNameManual}
                    onChange={(e) => setVerifierNameManual(e.target.value)}
                    placeholder="Type verifying RO name"
                    style={input}
                  />
                </label>
              )}

              {pendingRow.licenceType && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  <input type="checkbox" checked={verifiedChecked} onChange={(e) => setVerifiedChecked(e.target.checked)} />
                  I have sighted the relevant Licence/ID for this check-in.
                </label>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={confirmVerifyAndSave} style={{ ...btn, background: '#166534', color: '#fff' }}>Confirm & Save</button>
                <button
                  onClick={() => {
                    setVerifyOpen(false);
                    setPendingRow(null);
                    setVerifiedChecked(false);
                    setVerifierId('');
                    setVerifierNameManual('');
                  }}
                  style={btn}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Recent check-ins */}
          <div style={{ marginTop: 14, maxHeight: 260, overflow: 'auto', border: '1px solid #eee', borderRadius: 8 }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: '#fafafa' }}>
                <tr>
                  <th style={th}>Time</th>
                  <th style={th}>Member</th>
                  <th style={th}>Firearm</th>
                  <th style={th}>Class</th>
                  <th style={th}>Comp</th>
                  <th style={th}>Date</th>
                  <th style={th}>Verified</th>
                  <th style={th}>Verified by</th>
                  <th style={th}>Licence/ID</th>
                </tr>
              </thead>
              <tbody>
                {checkins.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ padding: 10, color: '#666' }}>No check-ins yet.</td>
                  </tr>
                ) : (
                  checkins.map((r, i) => (
                    <tr key={i}>
                      <td style={td}>{new Date(r.timestamp).toLocaleString()}</td>
                      <td style={td}>{r.name} ({r.memberId})</td>
                      <td style={td}>{r.firearm === 'H' ? 'Pistol (H)' : 'Long arms (A/B)'}</td>
                      <td style={td}>{r.klass}</td>
                      <td style={td}>{r.competition === 'TARGET' ? 'Target' : 'Metal Silhouette'}</td>
                      <td style={td}>{r.shootDate || ''}</td>
                      <td style={td}>{r.licenceType ? (r.licenceVerified ? 'Yes' : 'No') : 'N/A'}</td>
                      <td style={td}>{r.verifiedBy || ''}</td>
                      <td style={td}>{r.licenceType ? (r.licenceType === 'ID' ? r.licenceNo || '' : r.licenceNo || 'on file') : ''}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {msg && <div style={{ marginTop: 10, background: '#fff7ed', color: '#7c2d12', padding: 8, borderRadius: 8, fontSize: 12 }}>{msg}</div>}
        </section>
      </main>
    </div>
  );
}

// --- Styles ---
const btn = { background: '#fff', border: '1px solid #ddd', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', color: '#111' };
const miniBtn = { ...btn, padding: '4px 8px', fontSize: 12 };
const th = { textAlign: 'left', padding: '8px', borderBottom: '1px solid #eee' };
const td = { padding: '8px', borderTop: '1px solid #f2f2f2', verticalAlign: 'top', color: '#111' };
const label = { display: 'grid', gap: 6, fontSize: 12, color: '#111' };
const input = { border: '1px solid #ddd', borderRadius: 8, padding: '8px 10px', color: '#111', background: '#fff' };
