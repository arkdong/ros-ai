import './brand.css';

/** Original supplied PNGs; the wordmark window only trims transparent padding. */
export function Wordmark({className=''}:{className?:string}) {
  return <span className={`brand-wordmark ${className}`}><img src="/brand/ros-ai-wordmark.png" alt="ros.ai" width={1774} height={887}/></span>;
}

export function ResearchRing() {
  return <img className="research-ring" src="/brand/ros-ai-ring.png" alt="" aria-hidden="true" width={1024} height={1024}/>;
}
