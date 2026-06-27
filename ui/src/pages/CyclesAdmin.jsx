/**
 * Discovery & Cycles admin page.
 * Lets an admin trigger a fresh discovery/recertification cycle and shows the history
 * of runs with outcome numbers (resources, owners, certified/revoked/modified/pending).
 * @module pages/CyclesAdmin
 */

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { listCycles, triggerCycle } from '../utils/api.js';

const fmt = (iso) => {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }); } catch { return iso; }
};

const STATUS_COLORS = {
  ACTIVE: '#0972d3', INITIATING: '#8d6605', COMPLETED: '#037f0c', COMPLETED_WITH_OVERDUE: '#8d6605',
};

const Stat = ({ label, value, color }) => (
  <span style={{ display: 'inline-flex', flexDirection: 'column', minWidth: 64 }}>
    <span style={{ fontSize: 18, fontWeight: 700, color: color || '#16191f' }}>{value ?? 0}</span>
    <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#5f6b7a' }}>{label}</span>
  </span>
);

const CyclesAdmin = () => {
  const [cycles, setCycles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await listCycles();
      setCycles((res.data || res).cycles || []);
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load cycles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runDiscovery = async () => {
    setRunning(true);
    setNotice(null);
    setError(null);
    try {
      const res = await triggerCycle('AD_HOC');
      const cycleId = (res.data || res).cycleId;
      setNotice(`Discovery started for cycle ${cycleId}. Scanning owner-tagged resources…`);
      // Poll a few times while discovery runs asynchronously
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        await load();
      }
    } catch (e) {
      setError(e.message || 'Failed to start discovery');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ maxWidth: 1200 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Discovery &amp; Recertification Cycles</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} disabled={loading} style={btn(false)}>Refresh</button>
          <button onClick={runDiscovery} disabled={running} style={btn(true)}>
            {running ? 'Running discovery…' : 'Run Discovery'}
          </button>
        </div>
      </div>
      <p style={{ color: '#5f6b7a', fontSize: 13, marginTop: 0 }}>
        Run a fresh cycle to discover resources tagged <code>owner=&lt;email&gt;</code> and raise review requests to each owner.
      </p>

      {notice && <div style={banner('#f2f8fd', '#0972d3')}>{notice}</div>}
      {error && <div style={banner('#fff7f7', '#d91515')}>{error}</div>}

      <div style={{ background: '#fff', border: '1px solid #e9ebed', borderRadius: 8, overflow: 'hidden', marginTop: 12 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f2f3f3', textAlign: 'left' }}>
              {['Cycle', 'Type', 'Status', 'Started', 'Resources', 'Owners', 'Certified', 'Revoked', 'Modified', 'Pending', 'Completion'].map((h) => (
                <th key={h} style={{ padding: '10px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: '#414d5c' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (<tr><td colSpan={11} style={{ padding: 24, textAlign: 'center', color: '#5f6b7a' }}>Loading…</td></tr>)}
            {!loading && cycles.length === 0 && (<tr><td colSpan={11} style={{ padding: 24, textAlign: 'center', color: '#5f6b7a' }}>No cycles yet. Click “Run Discovery” to start one.</td></tr>)}
            {cycles.map((c) => {
              const s = c.stats || {};
              return (
                <tr key={c.cycleId} style={{ borderTop: '1px solid #e9ebed' }}>
                  <td style={td}><Link to={`/recert/${c.cycleId}`}>{c.cycleId}</Link></td>
                  <td style={td}>{c.cycleType}</td>
                  <td style={td}><span style={{ color: STATUS_COLORS[c.status] || '#5f6b7a', fontWeight: 600 }}>{c.status}</span></td>
                  <td style={td}>{fmt(c.startDate)}</td>
                  <td style={td}>{c.totalResources}</td>
                  <td style={td}>{c.totalOwners}</td>
                  <td style={{ ...td, color: '#037f0c', fontWeight: 600 }}>{s.certified ?? 0}</td>
                  <td style={{ ...td, color: '#d91515', fontWeight: 600 }}>{s.revoked ?? 0}</td>
                  <td style={{ ...td, color: '#8d6605', fontWeight: 600 }}>{s.modified ?? 0}</td>
                  <td style={td}>{s.pending ?? 0}</td>
                  <td style={td}>{c.completionPct ?? 0}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const td = { padding: '10px 12px', color: '#16191f' };
const btn = (primary) => ({
  padding: '7px 16px', borderRadius: 20, fontSize: 13, fontWeight: 700, cursor: 'pointer',
  border: primary ? '1px solid #0972d3' : '1px solid #7d8998',
  background: primary ? '#0972d3' : '#fff', color: primary ? '#fff' : '#16191f',
});
const banner = (bg, fg) => ({ background: bg, border: `1px solid ${fg}`, borderLeftWidth: 4, color: fg, padding: '10px 14px', borderRadius: 4, fontSize: 13, marginTop: 12 });

export default CyclesAdmin;
