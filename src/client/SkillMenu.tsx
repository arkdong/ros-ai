import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { BookText, Settings2 } from 'lucide-react';
import { api } from './api';
import './skills.css';

type MenuSkill = { name: string; title: string; description: string };
/** The /names already typed at the start of the request, then the one being typed now. */
const TYPING = /^((?:\/[a-z0-9]+(?:-[a-z0-9]+)*\s+)*)\/([a-z0-9-]*)$/u;
const wordsStartWith = (text: string, query: string) => {
  const words = text.toLowerCase().split(/[^a-z0-9]+/u);
  return query.split('-').filter(Boolean).every(part => words.some(word => word.startsWith(part)));
};

/** The / menu of ROS's composers: typing / at the start of a request lists the skills that are on; picking one
 * puts /name in front, and ROS then follows that skill for the request. onKeyDown returns true when the menu
 * used the key. */
export function useSkillMenu(draft: string, setDraft: (value: string) => void, onManage?: () => void) {
  const [skills, setSkills] = useState<MenuSkill[] | null>(null), [index, setIndex] = useState(0), [dismissed, setDismissed] = useState<string | null>(null);
  const typing = TYPING.exec(draft);
  // Escape closes the menu until the text no longer starts with what was there.
  const open = Boolean(typing) && !(dismissed !== null && draft.startsWith(dismissed));
  useEffect(() => {
    if (!open) return;
    let live = true;
    api<{ skills: MenuSkill[] }>('/api/skills/menu').then(value => { if (live) setSkills(value.skills); }, () => { if (live) setSkills([]); });
    return () => { live = false; };
  }, [open]);
  const query = typing?.[2] ?? '';
  // Names that start with what is typed come first, then names that contain it, then descriptions with words that start with it.
  const items = useMemo(() => (skills ?? [])
    .map(skill => ({ skill, rank: skill.name.startsWith(query) ? 0 : skill.name.includes(query) ? 1 : wordsStartWith(skill.description, query) ? 2 : 3 }))
    .filter(item => item.rank < 3).sort((a, b) => a.rank - b.rank || a.skill.name.localeCompare(b.skill.name)).slice(0, 8).map(item => item.skill), [skills, query]);
  useEffect(() => setIndex(0), [query]);
  const pick = (skill: MenuSkill) => setDraft(`${typing?.[1] ?? ''}/${skill.name} `);
  const onKeyDown = (event: KeyboardEvent): boolean => {
    if (!open || !skills || event.nativeEvent.isComposing) return false;
    if (event.key === 'Escape') { event.preventDefault(); setDismissed(draft); return true; }
    if (!items.length) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex(current => (current + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length); return true; }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { event.preventDefault(); pick(items[Math.min(index, items.length - 1)]!); return true; }
    return false;
  };
  // Buttons keep the focus in the composer (mouse down does not move it), so typing can go on after a click.
  const keep = (event: { preventDefault: () => void }) => event.preventDefault();
  const menu = open && skills ? <div className="ros-model-menu skill-menu" role="listbox" aria-label="Skills">
    <p>Skills</p>
    {items.map((skill, at) => <button key={skill.name} type="button" role="option" aria-selected={at === index} className={at === index ? 'active' : ''} onMouseDown={keep} onMouseEnter={() => setIndex(at)} onClick={() => pick(skill)}><BookText size={14}/><span className="ros-menu-label">/{skill.name}<small>{skill.description}</small></span></button>)}
    {!items.length && <p className="ros-menu-note">{skills.length ? `No skill called /${query}.` : 'No skills are on yet.'}</p>}
    {onManage && <><hr/><button type="button" onMouseDown={keep} onClick={onManage}><Settings2 size={14}/><span className="ros-menu-label">{skills.length ? 'Manage skills' : 'Add a skill'}</span></button></>}
  </div> : null;
  return { menu, onKeyDown, open: Boolean(menu) };
}
