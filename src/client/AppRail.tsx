import type { ReactNode } from 'react';
import { Battery, Cpu, LayoutDashboard, Library, Puzzle, type LucideIcon } from 'lucide-react';
import './app-rail.css';

export type RailPage = 'canvas' | 'model' | 'budget' | 'resources' | 'plugins';
const items: { page: RailPage; label: string; subtitle: string; icon: LucideIcon }[] = [
  { page: 'canvas', label: 'Canvas', subtitle: '', icon: LayoutDashboard },
  { page: 'model', label: 'Model', subtitle: 'AI models and local servers ros.ai can use', icon: Cpu },
  { page: 'budget', label: 'Budget', subtitle: 'What each connection may spend, and what this project used', icon: Battery },
  { page: 'resources', label: 'Resources', subtitle: 'Sources, files and exact saved versions in this project', icon: Library },
  { page: 'plugins', label: 'Plugins', subtitle: 'Connect the tools you already use', icon: Puzzle },
];

/** The slim icon column at the far left; each icon opens its own page over the canvas. */
export function AppRail({ page, onPage }: { page: RailPage; onPage: (page: RailPage) => void }) {
  return <nav className="app-rail" aria-label="Workspace pages">{items.map(item => <button key={item.page} className={`app-rail-button ${page === item.page ? 'active' : ''}`} aria-label={item.label} aria-current={page === item.page ? 'page' : undefined} data-tour-target={item.page === 'resources' ? 'resources-toggle' : undefined} onClick={() => onPage(item.page)}><item.icon size={18}/><span className="app-rail-hint" role="presentation">{item.label}</span></button>)}</nav>;
}

export function RailPageFrame({ page, children }: { page: Exclude<RailPage, 'canvas'>; children: ReactNode }) {
  const item = items.find(entry => entry.page === page)!;
  return <section className="rail-page" aria-label={item.label}><div className="rail-page-inner"><header className="rail-page-header"><span className="rail-page-icon"><item.icon size={20}/></span><div><h1>{item.label}</h1><p>{item.subtitle}</p></div></header>{children}</div></section>;
}
