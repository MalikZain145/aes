import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity, ScrollView, ActivityIndicator, Platform, TextInput,
  NativeModules,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Network from 'expo-network';
import { API_BASE, VERIFY_PATH } from './config';

// ── Backend auto-discovery ────────────────────────────────────────────────────
// The exam server runs on the admin's laptop; its LAN IP changes with the WiFi.
// The app FINDS it automatically — no manual IP setup:
//   • In Expo Go (dev), the JS bundle is served by Metro on the LAPTOP's LAN IP,
//     and the backend runs on that SAME laptop, so we read the Metro host IP and
//     use it directly (instant, exact — this is the primary path in dev).
//   • Otherwise it probes /api/health on the phone's own /24 subnet, the QR host,
//     the config fallback and any manual entry, then caches the hit.
let RESOLVED_BASE = null;
let MANUAL_BASE = null;
const clean = (b) => String(b || '').replace(/\/+$/, '');

// The laptop IP the Expo app was loaded from (Metro bundler). Backend = same
// laptop on port 5000 in dev, so this is the fastest, most reliable candidate.
function metroHostBase() {
  try {
    const url = (NativeModules && NativeModules.SourceCode && NativeModules.SourceCode.scriptURL) || '';
    const m = /^https?:\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d+)?/.exec(String(url));
    if (m && m[1] && !m[1].startsWith('127.') && !m[1].startsWith('0.')) return `http://${m[1]}:5000`;
  } catch { /* ignore */ }
  return null;
}

async function probe(base, timeout = 1500) {
  if (!base) return false;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    const r = await fetch(`${clean(base)}/api/health`, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

const _prefixOf = (u) => { const m = /(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}/.exec(String(u || '')); return m ? m[1] : null; };

async function discoverBackend(qrHost, onProgress) {
  // 1) fast path: manual override, last-known, the Metro/laptop IP (dev), the QR
  //    host, then the config fallback. The Metro IP resolves the dev case
  //    instantly with no scan and no manual setup.
  for (const b of [MANUAL_BASE, RESOLVED_BASE, metroHostBase(), qrHost, API_BASE].filter(Boolean).map(clean)) {
    if (await probe(b, 1300)) { RESOLVED_BASE = b; return b; }
  }
  // 2) subnet scan. Gather every /24 worth trying: the phone's OWN subnet, the
  //    subnet the QR host was on, and the config fallback's subnet — so it works
  //    even when the server's address changed with the network.
  const prefixes = [];
  const addPfx = (p) => { if (p && !p.startsWith('0.') && !p.startsWith('127.') && !prefixes.includes(p)) prefixes.push(p); };
  try { addPfx(_prefixOf(await Network.getIpAddressAsync())); } catch { /* ignore */ }
  addPfx(_prefixOf(qrHost));
  addPfx(_prefixOf(API_BASE));
  if (!prefixes.length) return null;

  // Prioritise the common host numbers (routers/laptops) so the usual case is
  // found in well under a second, then fall back to every address.
  const priority = [1, 100, 101, 102, 103, 104, 105, 10, 2, 3, 4, 5, 8, 20, 50, 150, 200, 254];
  const octets = [...priority, ...Array.from({ length: 254 }, (_, i) => i + 1)];
  const seen = new Set();
  const hosts = [];
  for (const pfx of prefixes) {
    for (const o of octets) {
      const h = `http://${pfx}.${o}:5000`;
      if (!seen.has(h)) { seen.add(h); hosts.push(h); }
    }
  }

  // Bounded-concurrency pool; return the first server that answers.
  const CONC = 40;
  let idx = 0, done = 0, found = null;
  async function worker() {
    while (idx < hosts.length && !found) {
      const h = hosts[idx++];
      if (await probe(h, 1200)) { if (!found) found = clean(h); return; }
      done += 1;
      if (onProgress) onProgress(Math.round((done / hosts.length) * 100));
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  if (found) { RESOLVED_BASE = found; return found; }
  return null;
}

const GREEN = '#0f5132';
const GREEN2 = '#198754';

// Prefix that marks a QR as an OFFICIAL Abasyn admit card. The QR is NOT a web
// URL (so no generic camera / QR app can open or verify it) — only this app knows
// the prefix, extracts the token, and checks it against the exam server (API_BASE).
const QR_PREFIX = 'ABASYN-ADMIT:';

// Parse a scanned QR into { base, token }, or null if it is not an Abasyn card.
function parseQR(data) {
  if (!data) return null;
  const s = String(data).trim();
  // Opaque format: the payload leads with a human notice ("Only a valid scanner
  // can scan.") and carries "ABASYN-ADMIT:<token>|<host:port>". We read the token
  // AND the server host straight from the QR — so the app auto-follows whatever
  // address the server had when the cards were generated (survives IP changes).
  // The host has no scheme, so a generic QR app still can't open it. If no host is
  // present we fall back to API_BASE from config.
  const p = s.indexOf(QR_PREFIX);
  if (p >= 0) {
    const rest = s.slice(p + QR_PREFIX.length);
    const bar = rest.indexOf('|');
    const tok = (bar >= 0 ? rest.slice(0, bar) : rest).split(/[/?#\s]/)[0];
    if (!/^[A-Za-z0-9]{6,}$/.test(tok)) return null;
    let base = String(API_BASE);
    if (bar >= 0) {
      const srv = rest.slice(bar + 1).split(/\s/)[0].trim();
      if (srv) base = /^https?:\/\//i.test(srv) ? srv : `http://${srv}`;
    }
    return { base: base.replace(/\/+$/, ''), token: tok };
  }
  // Backward-compat: old cards whose QR was a full "{base}/verify/<token>" URL.
  const i = s.indexOf(VERIFY_PATH);
  if (i === -1) return null;
  let base = s.slice(0, i);
  const tok = s.slice(i + VERIFY_PATH.length).split(/[/?#]/)[0];
  if (!/^[A-Za-z0-9]{6,}$/.test(tok)) return null;
  if (!/^https?:\/\//i.test(base)) base = API_BASE;
  return { base: base.replace(/\/+$/, ''), token: tok };
}

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState('scan');      // scan | loading | result
  const [result, setResult] = useState(null);
  const [server, setServer] = useState(RESOLVED_BASE || '');   // detected backend
  const [detecting, setDetecting] = useState(false);
  const [manualIp, setManualIp] = useState('');
  const lock = useRef(false);

  // find the server once when the app opens, so the first scan is instant
  useEffect(() => { detect(); }, []); // eslint-disable-line

  const detect = useCallback(async () => {
    setDetecting(true);
    try { const b = await discoverBackend(null); setServer(b || ''); }
    finally { setDetecting(false); }
  }, []);

  const saveManual = useCallback(() => {
    const v = manualIp.trim();
    if (!v) { MANUAL_BASE = null; return; }
    // accept "192.168.1.8", "192.168.1.8:5000" or a full URL
    let b = v;
    if (!/^https?:\/\//i.test(b)) b = `http://${b}`;
    if (!/:\d+/.test(b.replace(/^https?:\/\//, ''))) b = `${b}:5000`;
    MANUAL_BASE = clean(b); RESOLVED_BASE = MANUAL_BASE; setServer(MANUAL_BASE);
  }, [manualIp]);

  const startScan = useCallback(() => {
    lock.current = false;
    setResult(null);
    setMode('scan');
  }, []);

  const onScan = useCallback(async ({ data }) => {
    if (lock.current) return;
    lock.current = true;
    const parsed = parseQR(data);
    if (!parsed) {
      // Not an Abasyn admit-card QR at all (random / fake QR with no valid token).
      setResult({ type: 'not_student' });
      setMode('result');
      return;
    }
    setMode('loading');

    const verifyOn = async (base) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const res = await fetch(`${base}/api/verify/${parsed.token}`, { signal: ctrl.signal });
        clearTimeout(timer);
        return res;
      } catch { clearTimeout(timer); return null; }
    };

    try {
      // Resolve the backend on THIS network (auto-detect), ignoring any stale
      // host baked into the QR when it was generated on another network.
      let base = await discoverBackend(parsed.base);
      if (base) setServer(base);
      if (!base) {
        setResult({ type: 'error', message: 'Could not find the exam server on this network. Make sure the server is running and the phone is on the same WiFi, or set the server IP manually.' });
        setMode('result');
        return;
      }
      let res = await verifyOn(base);
      if (!res) {
        // The cached address may have gone stale (server moved) — drop it and
        // re-scan the network once before giving up.
        RESOLVED_BASE = null;
        base = await discoverBackend(parsed.base);
        if (base) { setServer(base); res = await verifyOn(base); }
      }
      if (!res) {
        setResult({ type: 'error', message: 'Cannot reach the server. Make sure the exam server is running and on the same WiFi.' });
      } else if (res.status === 404) {
        setResult({ type: 'record_not_found' });     // our-format QR, not in DB → fake
      } else if (res.ok) {
        const json = await res.json();
        if (json && json.ok) setResult({ type: 'valid', data: json });
        else setResult({ type: 'record_not_found' });
      } else {
        setResult({ type: 'error', message: `Server error (${res.status}).` });
      }
    } catch (e) {
      setResult({ type: 'error', message: 'Cannot reach the server. Make sure the exam server is running and on the same WiFi.' });
    }
    setMode('result');
  }, []);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.hTitle}>ABASYN UNIVERSITY</Text>
        <Text style={styles.hSub}>Examination System — Admit Card Scanner</Text>
      </View>

      {mode === 'scan' && (
        <ScannerView permission={permission} requestPermission={requestPermission} onScan={onScan} />
      )}
      {mode === 'loading' && (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={GREEN2} />
          <Text style={styles.muted}>Verifying…</Text>
        </View>
      )}
      {mode === 'result' && (
        <ResultView result={result} onNext={startScan} />
      )}

      {/* Server status — auto-detected on this network; manual override optional */}
      {mode === 'scan' && (
        <View style={styles.srvBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.srvLabel}>
              {detecting ? 'Detecting exam server…' : (server ? `Server: ${server.replace(/^https?:\/\//, '')}` : 'Server not found on this network')}
            </Text>
            <View style={styles.srvRow}>
              <TextInput
                style={styles.srvInput}
                placeholder="Set IP manually (e.g. 192.168.10.5)"
                placeholderTextColor="#8aa"
                autoCapitalize="none"
                keyboardType="default"
                value={manualIp}
                onChangeText={setManualIp}
                onSubmitEditing={saveManual}
              />
              <TouchableOpacity style={styles.srvBtn} onPress={saveManual}><Text style={styles.srvBtnT}>Set</Text></TouchableOpacity>
            </View>
          </View>
          <TouchableOpacity style={styles.srvDetect} onPress={detect} disabled={detecting}>
            {detecting ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.srvBtnT}>Re-detect</Text>}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function ScannerView({ permission, requestPermission, onScan }) {
  if (!permission) return <View style={styles.center}><ActivityIndicator color={GREEN2} /></View>;
  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.emoji}>📷</Text>
        <Text style={styles.msg}>Camera access is needed to scan admit cards.</Text>
        <TouchableOpacity style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Grant Camera Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }
  return (
    <View style={styles.scanWrap}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={onScan}
      />
      <View style={styles.overlay} pointerEvents="none">
        <View style={styles.frame} />
        <Text style={styles.scanHint}>Point the camera at the admit-card QR</Text>
      </View>
    </View>
  );
}

function ResultView({ result, onNext }) {
  return (
    <View style={styles.resultRoot}>
      <ScrollView contentContainerStyle={styles.resultScroll}>
        {result?.type === 'valid' && <ValidResult data={result.data} />}
        {result?.type === 'record_not_found' && (
          <Banner tone="bad" emoji="🚫" title="Record Not Found"
            sub="This admit card is not in the university records. It may be forged — do not allow entry." />
        )}
        {result?.type === 'not_student' && (
          <Banner tone="bad" emoji="⛔" title="Student Not Exists"
            sub="This QR is not a valid Abasyn admit card. Immediately inform the higher authority." />
        )}
        {result?.type === 'error' && (
          <Banner tone="warn" emoji="⚠️" title="Could not verify" sub={result.message} />
        )}
      </ScrollView>
      <TouchableOpacity style={styles.nextBtn} onPress={onNext}>
        <Text style={styles.nextText}>⟳  Scan Next</Text>
      </TouchableOpacity>
    </View>
  );
}

function Banner({ tone, emoji, title, sub }) {
  const bg = tone === 'bad' ? '#f8d7da' : '#fff3cd';
  const fg = tone === 'bad' ? '#842029' : '#664d03';
  return (
    <View style={[styles.banner, { backgroundColor: bg }]}>
      <Text style={styles.bannerEmoji}>{emoji}</Text>
      <Text style={[styles.bannerTitle, { color: fg }]}>{title}</Text>
      <Text style={[styles.bannerSub, { color: fg }]}>{sub}</Text>
    </View>
  );
}

function ValidResult({ data }) {
  const s = data.student || {};
  const feePaid = /paid/i.test(data.feeStatus || '');
  return (
    <View>
      <View style={styles.stuCard}>
        <Text style={styles.stuName}>{s.name || '—'}</Text>
        <Row k="Registration No" v={s.registrationNo} />
        <Row k="Degree" v={s.degree} />
        <Row k="Batch" v={s.batch} />
        <View style={[styles.feePill, { backgroundColor: feePaid ? '#d1e7dd' : '#f8d7da' }]}>
          <Text style={{ color: feePaid ? GREEN : '#842029', fontWeight: '800', fontSize: 12 }}>
            ● Fee: {data.feeStatus || 'Paid'}
          </Text>
        </View>
      </View>

      {data.status === 'today' && (
        <View>
          <Text style={styles.sectionLabel}>TODAY'S PAPER</Text>
          {(data.today || []).map((e, i) => <ExamCard key={i} e={e} />)}
        </View>
      )}
      {data.status === 'over' && (
        <Banner tone="warn" emoji="✅" title="No exams found" sub="All papers for this student are over." />
      )}
      {data.status === 'no_today' && (
        <Banner tone="warn" emoji="🗓️" title="No exam today"
          sub="There is no paper scheduled for today for this student." />
      )}
      {data.status === 'no_exams' && (
        <Banner tone="warn" emoji="📄" title="No exams found" sub="No papers are recorded for this admit card." />
      )}
    </View>
  );
}

function ExamCard({ e }) {
  const stateColor = e.state === 'active' ? '#664d03' : e.state === 'completed' ? '#41464b' : '#084298';
  const stateBg = e.state === 'active' ? '#fff3cd' : e.state === 'completed' ? '#e2e3e5' : '#cfe2ff';
  const stateText = e.state === 'active' ? 'IN PROGRESS' : e.state === 'completed' ? 'COMPLETED' : 'UPCOMING';
  return (
    <View style={styles.examCard}>
      <View style={styles.examTop}>
        <Text style={styles.examCode}>{e.code}</Text>
        <View style={[styles.statePill, { backgroundColor: stateBg }]}>
          <Text style={{ color: stateColor, fontWeight: '800', fontSize: 10 }}>{stateText}</Text>
        </View>
      </View>
      <Text style={styles.examName}>{e.name}</Text>
      <View style={styles.grid}>
        <KV k="Date" v={e.dateDisp || e.date} />
        <KV k="Time" v={e.slot} />
        <KV k="Exam Hall" v={e.room} />
        <KV k="Seat No" v={e.seat} />
      </View>
    </View>
  );
}

const Row = ({ k, v }) => (
  <View style={styles.row}><Text style={styles.rowK}>{k}</Text><Text style={styles.rowV}>{v || '—'}</Text></View>
);
const KV = ({ k, v }) => (
  <View style={styles.kv}><Text style={styles.kvK}>{k}</Text><Text style={styles.kvV}>{v || '—'}</Text></View>
);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#eef4f0' },
  srvBar: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: '#0f5132' },
  srvLabel: { color: '#daf0e4', fontSize: 12, fontWeight: '700', marginBottom: 6 },
  srvRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  srvInput: { flex: 1, backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, fontSize: 13, color: '#0f5132' },
  srvBtn: { backgroundColor: '#198754', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  srvBtnT: { color: '#fff', fontWeight: '800', fontSize: 12 },
  srvDetect: { backgroundColor: '#198754', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, minWidth: 78, alignItems: 'center' },
  header: { paddingTop: Platform.OS === 'ios' ? 58 : 40, paddingBottom: 14, paddingHorizontal: 18,
    backgroundColor: GREEN, alignItems: 'center' },
  hTitle: { color: '#fff', fontSize: 18, fontWeight: '800', letterSpacing: 0.5 },
  hSub: { color: '#cfe8db', fontSize: 12, marginTop: 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emoji: { fontSize: 44, marginBottom: 12 },
  msg: { fontSize: 15, color: '#334', textAlign: 'center', marginBottom: 16 },
  muted: { color: '#5c6b63', marginTop: 10 },

  scanWrap: { flex: 1, overflow: 'hidden' },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  frame: { width: 240, height: 240, borderWidth: 3, borderColor: '#fff', borderRadius: 22,
    backgroundColor: 'transparent' },
  scanHint: { color: '#fff', marginTop: 18, fontSize: 14, backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, overflow: 'hidden' },

  resultRoot: { flex: 1 },
  resultScroll: { padding: 16, paddingBottom: 90 },
  stuCard: { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 14,
    shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 10, elevation: 2 },
  stuName: { fontSize: 20, fontWeight: '800', color: '#12261c' },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  rowK: { color: '#6c7b72', fontSize: 13 },
  rowV: { color: '#12261c', fontWeight: '700', fontSize: 13 },
  feePill: { alignSelf: 'flex-start', marginTop: 12, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999 },

  sectionLabel: { color: '#6c7b72', fontWeight: '800', fontSize: 12, letterSpacing: 0.6, marginBottom: 8, marginLeft: 2 },
  examCard: { backgroundColor: '#f6fbf8', borderColor: '#cfe6da', borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 12 },
  examTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  examCode: { fontSize: 20, fontWeight: '800', color: GREEN },
  statePill: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999 },
  examName: { fontSize: 14, color: '#12261c', marginTop: 2, marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  kv: { width: '50%', marginBottom: 10 },
  kvK: { fontSize: 11, color: '#6c7b72', textTransform: 'uppercase', letterSpacing: 0.4 },
  kvV: { fontSize: 16, fontWeight: '800', color: '#12261c' },

  banner: { borderRadius: 16, padding: 22, alignItems: 'center', marginTop: 6 },
  bannerEmoji: { fontSize: 40 },
  bannerTitle: { fontSize: 20, fontWeight: '800', marginTop: 8 },
  bannerSub: { fontSize: 13.5, textAlign: 'center', marginTop: 6, lineHeight: 19 },

  nextBtn: { position: 'absolute', left: 16, right: 16, bottom: 20, backgroundColor: GREEN2,
    borderRadius: 999, paddingVertical: 15, alignItems: 'center' },
  nextText: { color: '#fff', fontSize: 16, fontWeight: '800' },

  btn: { backgroundColor: GREEN2, borderRadius: 999, paddingVertical: 13, paddingHorizontal: 22 },
  btnText: { color: '#fff', fontWeight: '700' },
});
