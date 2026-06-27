/**
 * App root - recertification-only routing.
 * Trimmed to Login + Recertification (engine-backed). Other tabs removed.
 * @module App
 */

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './components/AuthProvider.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import RecertificationReview from './pages/RecertificationReview.jsx';
import './App.css';

/** Current fiscal-quarter cycle id, e.g. "2026-Q2". */
const currentCycleId = () => {
  const now = new Date();
  return `${now.getFullYear()}-Q${Math.ceil((now.getMonth() + 1) / 3)}`;
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
          <Route index element={<Navigate to={`/recert/${currentCycleId()}`} replace />} />
          <Route path="recert/:cycleId" element={<RecertificationReview />} />
          <Route path="recert" element={<Navigate to={`/recert/${currentCycleId()}`} replace />} />
        </Route>
        <Route path="*" element={<Login />} />
      </Routes>
    </BrowserRouter>
  </AuthProvider>
);

export default App;
