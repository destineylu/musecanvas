import { FolderOpen } from 'lucide-react';
import { LibraryBrowser } from '../components/CanvasWorkbench.jsx';
export default function Library(){return <main className="wb-page"><header><FolderOpen size={22} className="text-brand-500"/><h1>素材库</h1></header><LibraryBrowser/></main>;}
