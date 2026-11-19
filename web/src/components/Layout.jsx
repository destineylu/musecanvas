import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { BookOpen, FolderKanban, FolderOpen, Workflow, Settings, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { clsx } from 'clsx';
import { useAuth } from '../store/auth.jsx';
import ShortcutsGuide from './ShortcutsGuide.jsx';
import webPackage from '../../package.json';
const displayVersion = webPackage.version.split('.').slice(0, 2).join('.');


const NAV = [
  { to: '/projects', label: '项目管理', icon: FolderKanban },
  { to: '/scratch', label: '独立画布', icon: Workflow },
  { to: '/library', label: '素材库', icon: FolderOpen },
];

export default function Layout() {
  const { user } = useAuth();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const inCanvas = /^(?:\/scratch)?\/canvas\/[^/]+\/?$/.test(pathname);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const sidebarKey = `mua_sidebar_expanded_${user?.id || user?.email || 'default'}`;
  const [navigationExpanded, setNavigationExpanded] = useState(() => {
    try { return localStorage.getItem(sidebarKey) !== '0'; } catch { return true; }
  });
  const sidebarOpen = !inCanvas && navigationExpanded;

  const toggleSidebar = () => setNavigationExpanded((current) => {
    const next = !current;
    try { localStorage.setItem(sidebarKey, next ? '1' : '0'); } catch { /* Keep the current session preference. */ }
    return next;
  });

  return (
    <div className="muse-shell relative flex h-full overflow-hidden bg-ink-900">
      {/* ---------------- 侧边栏 ---------------- */}
      {!inCanvas && <aside className={clsx('muse-navigation relative z-40 flex shrink-0 flex-col border-r border-ink-600 py-3 transition-[width] duration-200', sidebarOpen ? 'w-[216px]' : 'w-[56px]')}>
        <div className={clsx('flex w-full items-center px-3', sidebarOpen ? 'justify-between' : 'flex-col gap-2 px-1')}>
          <button type="button" onClick={() => nav('/projects')} title="musecanvas 项目" aria-label="musecanvas 项目" className="muse-brand-button flex h-10 items-center gap-2.5">
            <img src="/brand/musecanvas-cat.png" alt="" draggable="false" width="36" height="36" className="muse-logo" />
            {sidebarOpen && <span className="muse-wordmark">musecanvas</span>}
          </button>
          {!inCanvas && (
            <button
              type="button"
              onClick={toggleSidebar}
              title={sidebarOpen ? '收起侧栏' : '展开侧栏'}
              aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
              className="muse-nav-button grid h-8 w-8 shrink-0 place-items-center rounded-lg"
            >
              {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </button>
          )}
        </div>

        <nav className={clsx('mt-5 flex w-full flex-col gap-1', sidebarOpen ? 'items-stretch px-3' : 'items-center px-2')}>
          {NAV.map((item) => (
            <NavItem key={item.to} {...item} expanded={sidebarOpen} />
          ))}
          <button
            type="button"
            title="使用教程"
            onClick={() => setTutorialOpen(true)}
            className={clsx(
              'group relative flex w-full items-center rounded-2xl py-2.5 transition',
              sidebarOpen ? 'gap-3 px-3 text-left' : 'justify-center',
              'text-mist-400 hover:bg-ink-800 hover:text-ink-950'
            )}
          >
            <BookOpen size={19} strokeWidth={1.8} />
            {sidebarOpen && <span className="text-[13px] font-medium">使用教程</span>}
          </button>
        </nav>

        <div className={clsx('mt-auto flex w-full flex-col gap-2', sidebarOpen ? 'items-stretch px-3' : 'items-center')}>
          <NavItem to="/settings" label="设置" icon={Settings} expanded={sidebarOpen} />
          <span className={clsx('mt-1 font-mono tracking-wide text-mist-400/70', sidebarOpen ? 'px-3 text-[10px]' : 'text-center text-[8px]')}>{sidebarOpen ? `musecanvas v${displayVersion}` : `v${displayVersion}`}</span>
        </div>
      </aside>}

      {/* ---------------- 主区 ---------------- */}
      <main className={clsx("muse-main min-h-0 min-w-0 flex-1", inCanvas ? "overflow-hidden" : "overflow-y-auto")}>
        <Outlet />
      </main>

      <ShortcutsGuide open={tutorialOpen} onClose={() => setTutorialOpen(false)} />
    </div>
  );
}

function NavItem({ to, label, icon: Icon, expanded }) {
  return (
    <NavLink
      to={to}
      title={label}
      className={({ isActive }) =>
        clsx(
          'group relative flex w-full rounded-2xl py-2.5 transition',
          expanded ? 'items-center gap-3 px-3' : 'items-center justify-center',
          isActive ? 'bg-brand-500/10 text-brand-500' : 'text-mist-400 hover:bg-ink-800 hover:text-ink-950'
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="muse-nav-marker absolute -left-2 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-brand-400" />
          )}
          <Icon size={19} strokeWidth={1.8} className={isActive ? 'text-brand-300' : ''} />
          <span className={expanded ? "text-[13px] font-medium" : "sr-only"}>{label}</span>
        </>
      )}
    </NavLink>
  );
}
