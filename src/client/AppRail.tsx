import type { ReactNode } from 'react';
import { Bot, LayoutDashboard, Plug, Settings2, type LucideIcon } from 'lucide-react';
import './app-rail.css';

export type RailPage = 'canvas' | 'model' | 'budget' | 'resources' | 'plugins';
type RailItem = { id: string; pages: RailPage[]; label: string; subtitle: string; icon: LucideIcon };
// Budget and Resources share the Settings entry; the page values stay so existing links keep working.
const items: RailItem[] = [
  { id: 'canvas', pages: ['canvas'], label: 'Canvas', subtitle: '', icon: LayoutDashboard },
  { id: 'agents', pages: ['model'], label: 'Agents', subtitle: 'Every agent that can work in your projects, connected the same way', icon: Bot },
  { id: 'plugins', pages: ['plugins'], label: 'Plugins', subtitle: 'Connect plugins so your agents work across your tools', icon: Plug },
  { id: 'settings', pages: ['budget', 'resources'], label: 'Settings', subtitle: 'Spending, sources and saved versions', icon: Settings2 },
];
const settingsTabs: { page: RailPage; label: string }[] = [{ page: 'budget', label: 'Budget' }, { page: 'resources', label: 'Resources' }];

/** The slim icon column at the far left; each icon opens its own page over the canvas. */
export function AppRail({ page, onPage }: { page: RailPage; onPage: (page: RailPage) => void }) {
  const button = (item: RailItem) => {
    const active = item.pages.includes(page);
    return <button key={item.id} className={`app-rail-button ${active ? 'active' : ''}`} aria-label={item.label} aria-current={active ? 'page' : undefined} data-tour-target={item.id === 'settings' ? 'resources-toggle' : undefined} onClick={() => onPage(active && item.id === 'settings' ? page : item.pages[0])}><item.icon size={18}/><span className="app-rail-hint" role="presentation">{item.label}</span></button>;
  };
  return <nav className="app-rail" aria-label="Workspace pages">{items.slice(0, 3).map(button)}<span className="app-rail-spacer"/>{button(items[3])}</nav>;
}

export function RailPageFrame({ page, onPage, children }: { page: Exclude<RailPage, 'canvas'>; onPage: (page: RailPage) => void; children: ReactNode }) {
  const item = items.find(entry => entry.pages.includes(page))!;
  // The Plugins page draws its own heading, like its catalogue rows.
  if (item.id === 'plugins') return <section className="rail-page" aria-label={item.label}><div className="rail-page-inner">{children}</div></section>;
  return <section className="rail-page" aria-label={item.label}><div className="rail-page-inner"><header className="rail-page-header"><span className="rail-page-icon"><item.icon size={20}/></span><div><h1>{item.label}</h1><p>{item.subtitle}</p></div></header>
    {item.id === 'settings' && <div className="rail-page-tabs" role="tablist" aria-label="Settings">{settingsTabs.map(tab => <button key={tab.page} role="tab" aria-selected={page === tab.page} className={page === tab.page ? 'active' : ''} onClick={() => onPage(tab.page)}>{tab.label}</button>)}</div>}
    {children}</div></section>;
}
