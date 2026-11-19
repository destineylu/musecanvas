import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './store/auth.jsx';
import { ToastProvider, Spinner } from './components/ui.jsx';
import Layout from './components/Layout.jsx';
import Settings from './pages/Settings.jsx';
import Library from './pages/Library.jsx';
import Projects from './pages/Projects.jsx';
import ProjectDetail from './pages/ProjectDetail.jsx';
import Canvas from './pages/Canvas.jsx';
import Accounts from './pages/Accounts.jsx';
import Bind from './pages/Bind.jsx';
import Login from './pages/Login.jsx';
import './studio.css';

function Boot() {
  return <div className="grid h-full place-items-center bg-[#f3f4f8] text-brand-500"><Spinner size={26} /></div>;
}

function Guard({ children }) {
  const { user, loading, error, refresh, mode } = useAuth();
  if (loading) return <Boot />;
  if(!user&&mode==='account')return <Navigate to="/login" replace/>;
  if (!user) return <div className="grid h-full place-items-center p-8"><div><p role="alert">{error || '工作区连接失败'}</p><button className="mt-4 text-brand-500" onClick={refresh}>重新连接</button></div></div>;
  return children;
}

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route
          path="/login"
          element={<LoginEntry/>}
        />
        <Route path="/bind/:code" element={<Guard><Bind /></Guard>} />

        <Route
          element={
            <Guard>
              <Layout />
            </Guard>
          }
        >
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
          <Route path="/scratch" element={<ProjectDetail scratch />} />
          <Route path="/scratch/canvas/:canvasId" element={<Canvas />} />
          <Route path="/canvas/:canvasId" element={<Canvas />} />
          <Route path="/canvas" element={<Navigate to="/scratch" replace />} />
          <Route path="/create" element={<Navigate to="/projects" replace />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/bridge" element={<Navigate to="/settings" replace />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/library" element={<Library />} />
        </Route>

        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </ToastProvider>
  );
}
function LoginEntry(){const {mode,user,loading}=useAuth();if(loading)return <Boot/>;return mode==='account'&&!user?<Login/>:<Navigate to="/projects" replace/>;}
