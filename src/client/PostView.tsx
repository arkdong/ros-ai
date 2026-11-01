import { useEffect, useState } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, LoaderCircle, Play } from 'lucide-react';
import type { PostPlatform, PostView } from '../shared/types';
import { POST_PLATFORM_NAMES, duration, postCounts, shortCount } from '../shared/posts';
import { api } from './api';
import { BrandLogo } from './brand-logos';
import './post-block.css';

/** A saved photo of a Post block, served from posts/ in the project folder; undefined when it was not saved. */
const photoSrc = (projectId: string, nodeId: string, post: PostView, index: number) => post.photos[index]?.path ? `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/post/${index}?v=${encodeURIComponent(post.readAt)}` : undefined;
const when = (at: string | undefined) => {
  if (!at) return '';
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString([], { day: 'numeric', month: 'short', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};

export function PostLogo({ platform, size }: { platform: PostPlatform; size: number }) {
  return <BrandLogo id={platform} size={size}/>;
}

function Counts({ post }: { post: PostView }) {
  const shown = postCounts(post);
  if (!shown.length) return null;
  return <span className="post-counts">{shown.map(item => <span key={item.key} title={`${item.value.toLocaleString('en-US')} ${item.label}`}><strong>{shortCount(item.value)}</strong> {item.label}</span>)}</span>;
}

/** A Post block on the map, shaped by its platform: a video by its thumbnail, a photo post by its cover, a thread or a
 * repository as text with its author line. The block's title is the post's, so the card shows it once, here. */
export function PostCard({ projectId, nodeId, post, title }: { projectId: string; nodeId: string; post: PostView; title: string }) {
  const cover = photoSrc(projectId, nodeId, post, 0);
  const byline = <span className="post-byline"><span className="post-author">{post.author.name}</span>{post.community && post.community !== post.author.name && <span className="post-community">{post.community}</span>}{post.postedAt && <span>{when(post.postedAt)}</span>}</span>;
  if (post.shape === 'video') return <div className="post-face post-face-video">
    <div className="post-cover video">{cover ? <img src={cover} alt="" loading="lazy" draggable={false}/> : <span className="post-cover-empty"><Play size={22}/></span>}{post.duration !== undefined && <span className="post-duration">{duration(post.duration)}</span>}</div>
    <strong className="post-title">{title}</strong>{byline}<Counts post={post}/>
  </div>;
  if (post.shape === 'photo' && cover) return <div className="post-face post-face-photo">
    <div className="post-cover photo"><img src={cover} alt="" loading="lazy" draggable={false}/>{post.photos.length > 1 && <span className="post-duration">1/{post.photos.length}</span>}</div>
    <strong className="post-title">{title}</strong>{byline}<Counts post={post}/>
  </div>;
  return <div className="post-face post-face-text">
    {byline}<strong className="post-title">{title}</strong>
    {post.text && post.text !== title && <p className="post-text">{post.text.slice(0, 400)}</p>}
    {cover && <div className="post-strip">{post.photos.slice(0, 3).map((_, index) => { const src = photoSrc(projectId, nodeId, post, index); return src ? <img key={index} src={src} alt="" loading="lazy" draggable={false}/> : null; })}</div>}
    <Counts post={post}/>
  </div>;
}

/** A Post block opened: its photos to step through (or a video's thumbnail), the whole text, tags, counts, the top
 * comments and a video's subtitles, with a link back to the post. */
export function PostSheet({ projectId, nodeId, post, title }: { projectId: string; nodeId: string; post: PostView; title: string }) {
  const photos = post.photos.map((_, index) => photoSrc(projectId, nodeId, post, index)).filter((src): src is string => Boolean(src));
  const [shown, setShown] = useState(0), [subtitles, setSubtitles] = useState<string | null>(post.subtitles?.text ?? null), [loading, setLoading] = useState(false), [problem, setProblem] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => { setShown(0); }, [nodeId]);
  useEffect(() => {
    if (!open || subtitles !== null || !post.subtitles?.path) return;
    let live = true;
    setLoading(true);
    api<{ text: string }>(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/post-subtitles`).then(got => { if (live) setSubtitles(got.text); }, reason => { if (live) setProblem(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [open, subtitles, post.subtitles?.path, projectId, nodeId]);
  const name = POST_PLATFORM_NAMES[post.platform];
  return <div className={`post-sheet${photos.length ? '' : ' no-media'}`}>
    {photos.length > 0 && <div className={`post-media ${post.shape === 'video' ? 'video' : ''}`}>
      <img src={photos[Math.min(shown, photos.length - 1)]} alt={`${title}, picture ${shown + 1} of ${photos.length}`} draggable={false}/>
      {post.shape === 'video' && <a className="post-play" href={post.url} target="_blank" rel="noreferrer" aria-label={`Play on ${name}`}><Play size={26}/></a>}
      {photos.length > 1 && <>
        <button type="button" className="post-step prev" aria-label="Previous picture" disabled={shown === 0} onClick={() => setShown(shown - 1)}><ChevronLeft size={18}/></button>
        <button type="button" className="post-step next" aria-label="Next picture" disabled={shown >= photos.length - 1} onClick={() => setShown(shown + 1)}><ChevronRight size={18}/></button>
        <span className="post-dots" aria-hidden="true">{photos.map((_, index) => <i key={index} className={index === shown ? 'on' : ''}/>)}</span>
      </>}
    </div>}
    <div className="post-body">
      <div className="post-who">{post.author.url ? <a href={post.author.url} target="_blank" rel="noreferrer">{post.author.name}</a> : <span>{post.author.name}</span>}{post.community && post.community !== post.author.name && <span className="post-community">{post.community}</span>}</div>
      <h3 className="post-heading">{title}</h3>
      {post.text && post.text !== title && <div className="post-full-text">{post.text}</div>}
      {post.tags?.length ? <p className="post-tags">{post.tags.map(tag => `#${tag.replace(/\s+/gu, '')}`).join(' ')}</p> : null}
      <div className="post-meta"><Counts post={post}/>{post.duration !== undefined && <span>{duration(post.duration)}</span>}{post.postedAt && <span>Posted {when(post.postedAt)}</span>}</div>
      {post.notice && <p className="post-notice">{post.notice}</p>}
      {post.comments?.length ? <section className="post-comments" aria-label="Top comments">
        <h4>Top comments</h4>
        {post.comments.map((comment, index) => <div key={index} className="post-comment" style={{ marginLeft: Math.min(3, comment.depth ?? 0) * 14 }}>
          <span className="post-comment-who">{comment.author}{comment.likes !== undefined && <small> · {shortCount(comment.likes)}</small>}</span>
          <p>{comment.text}</p>
        </div>)}
      </section> : null}
      {post.subtitles && <section className="post-subtitles">
        <button type="button" className="text-button small" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide subtitles' : `Subtitles · ${post.subtitles.language}${post.subtitles.automatic ? ' (automatic)' : ''} · ${shortCount(post.subtitles.characters)} characters`}</button>
        {open && (loading ? <p className="post-notice"><LoaderCircle size={12} className="spin"/> Reading…</p> : problem ? <p className="post-notice">{problem}</p> : <div className="post-full-text subtitles">{subtitles}</div>)}
      </section>}
      <div className="post-foot"><span>{name} · read {new Date(post.readAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{post.photos.some(photo => photo.path) ? ' · photos saved in posts/' : ''}</span><a href={post.url} target="_blank" rel="noreferrer">Open in {name} <ArrowUpRight size={12}/></a></div>
    </div>
  </div>;
}
