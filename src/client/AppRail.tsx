import type { ReactNode } from 'react';
import { BookText, Bot, LayoutDashboard, Plug, Settings2, type LucideIcon } from 'lucide-react';
import './app-rail.css';

export type RailPage = 'canvas' | 'model' | 'usage' | 'balances' | 'general' | 'resources' | 'memory' | 'plugins' | 'skills';
type RailItem = { id: string; pages: RailPage[]; label: string; subtitle: string; icon: LucideIcon };
// Usage, Balances, General and Resources share the Settings entry; its sections sit in the left menu.
const items: RailItem[] = [
  { id: 'canvas', pages: ['canvas'], label: 'Canvas', subtitle: '', icon: LayoutDashboard },
  { id: 'agents', pages: ['model'], label: 'Agents', subtitle: 'Every agent that can work in your projects, connected the same way', icon: Bot },
  { id: 'plugins', pages: ['plugins'], label: 'Plugins', subtitle: 'Connect plugins so your agents work across your tools', icon: Plug },
  { id: 'skills', pages: ['skills'], label: 'Skills', subtitle: 'Ways of working your agents follow when a task matches', icon: BookText },
  { id: 'settings', pages: ['usage', 'balances', 'general', 'resources', 'memory'], label: 'Settings', subtitle: '', icon: Settings2 },
];

/** The slim icon column at the far left; each icon opens its own page over the canvas. */
export function AppRail({ page, onPage }: { page: RailPage; onPage: (page: RailPage) => void }) {
  const button = (item: RailItem) => {
    const active = item.pages.includes(page);
    return <button key={item.id} className={`app-rail-button ${active ? 'active' : ''}`} aria-label={item.label} aria-current={active ? 'page' : undefined} data-tour-target={item.id === 'settings' ? 'resources-toggle' : undefined} onClick={() => onPage(active && item.id === 'settings' ? page : item.pages[0])}><item.icon size={18}/><span className="app-rail-hint" role="presentation">{item.label}</span></button>;
  };
  return <nav className="app-rail" aria-label="Workspace pages">{items.slice(0, -1).map(button)}<span className="app-rail-spacer"/>{button(items[items.length - 1]!)}</nav>;
}

export function RailPageFrame({ page, children }: { page: Exclude<RailPage, 'canvas'>; children: ReactNode }) {
  const item = items.find(entry => entry.pages.includes(page))!;
  // Every page draws its own heading; its sections live in the left menu. All pages share one column so switching never shifts it.
  return <section className="rail-page" aria-label={item.label}><div className="rail-page-inner">{children}</div></section>;
}
