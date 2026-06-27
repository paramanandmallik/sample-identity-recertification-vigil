/**
 * Application layout - AWS Management Console (Cloudscape) shell.
 * Full-width squid-ink global top navigation, white side navigation panel,
 * and a grey content canvas. Built for compliance auditors and IT governance admins.
 * @module components/Layout
 */

import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider.jsx';
import './Layout.css';

/**
 * Compute the current fiscal quarter cycle ID (e.g. "2026-Q2").
 * @returns {string}
 */
const getCurrentCycleId = () => {
  const now = new Date();
  const q = Math.ceil((now.getMonth() + 1) / 3);
  return `${now.getFullYear()}-Q${q}`;
};

/**
 * Layout component with AWS-style global top nav and side navigation.
 */
const Layout = () => {
  const { user, handleSignOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const isRecertActive = location.pathname.startsWith('/recert');

  const NAV_ITEMS = [];

  const handleRecertClick = (e) => {
    e.preventDefault();
    navigate(`/recert/${getCurrentCycleId()}`);
  };

  const userLabel = user?.email || user?.username || 'User';
  const groupsLabel = (user?.groups || []).join(', ') || 'No groups';

  return (
    <div className="aws-shell">
      {/* Global top navigation (squid ink) */}
      <header className="aws-topnav">
        <div className="aws-topnav-left">
          <span className="aws-topnav-logo">VIGIL</span>
          <span className="aws-topnav-sep" aria-hidden="true" />
          <span className="aws-topnav-service">Identity Governance &amp; Intelligence</span>
        </div>
        <div className="aws-topnav-right">
          <span className="aws-topnav-region">IST (UTC+5:30)</span>
          <span className="aws-topnav-user" title={groupsLabel}>{userLabel}</span>
          <button className="aws-topnav-signout" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <div className="aws-body">
        {/* Side navigation (white Cloudscape panel) */}
        <aside className="aws-sidenav">
          <div className="aws-sidenav-title">Identity Governance</div>
          <nav className="aws-sidenav-nav">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                className={({ isActive }) =>
                  `aws-navlink ${isActive ? 'aws-navlink--active' : ''}`
                }
              >
                {item.label}
              </NavLink>
            ))}
              <NavLink
              to="/recert"
              className={`aws-navlink ${isRecertActive ? 'aws-navlink--active' : ''}`}
            >
              Recertification
            </NavLink>
            {(user?.groups || []).includes('admin') && (
              <NavLink
                to="/admin"
                className={({ isActive }) => `aws-navlink ${isActive ? 'aws-navlink--active' : ''}`}
              >
                Discovery
              </NavLink>
            )}
          </nav>
          <div className="aws-sidenav-footer">
            <span className="aws-sidenav-user">{userLabel}</span>
            <span className="aws-sidenav-groups">{groupsLabel}</span>
          </div>
        </aside>

        {/* Content canvas */}
        <main className="aws-main">
          <div className="aws-content">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
};

export default Layout;
