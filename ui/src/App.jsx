/**
 * App root - recertification-only routing.
 * Trimmed to Login + Recertification (engine-backed). Other tabs removed.
 * @module App
 */

import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './components/AuthProvider.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import RecertificationReview from './pages/RecertificationReview.jsx';
import CyclesAdmin from './pages/CyclesAdmin.jsx';
import { listCycles } from './utils/api.js';
import './App.css';

/** Fallback fiscal-quarter cycle id (only used if no cycles exist yet), e.g. "2026-Q2". */
const currentCycleId = () => {
  const now = new Date();
  return `${now.getFullYear()}-Q${Math.ceil((now.getMonth() + 1) / 3)}`;
};

/**
 * Resolve the Recertification landing to the most relevant cycle: the latest
 * ACTIVE cycle if one exists, otherwise the most recently created cycle. Falls
 * back to the quarterly id only when no cycles exist (or the call fails).
 */
const RecertEntry = () => {
  const [target, setTarget] = useState(null);

  useEffect(() => {
    let cancelled = false;
    listCycles()
      .then((res) => {
        const cycles = (res?.data || res)?.cycles || [];
        // listCycles returns newest-first; prefer the latest ACTIVE cycle.
        const pick = cycles.find((c) => c.status === 'ACTIVE') || cycles[0];
        if (!cancelled) setTarget(pick?.cycleId || currentCycleId());
      })
      .catch(() => { if (!cancelled) setTarget(currentCycleId()); });
    return () => { cancelled = true; };
  }, []);

  if (!target) return null; // brief loading state while resolving
  return <Navigate to={`/recert/${target}`} replace />;
};

const App = () => (
  <AuthProvider>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<RecertEntry />} />
          <Route path="recert/:cycleId" element={<RecertificationReview />} />
          <Route path="recert" element={<RecertEntry />} />
          <Route path="admin" element={<CyclesAdmin />} />
        </Route>
        <Route path="*" element={<Login />} />
      </Routes>
    </BrowserRouter>
  </AuthProvider>
);

export default App;
