/** Connect your tools opens its sign-ins one after another in one window, and each sign-in ends on a page of ros.ai's own.
 * That page waits there to be told what comes next: ros.ai asks over a BroadcastChannel, which still reaches it when the
 * browser has cut the window off from the page that opened it, as sign-in pages that isolate themselves make it do. It
 * answers, then opens the next page (a web address only) or closes; a window the browser keeps open says it can be
 * closed. It stops listening after 15 minutes. */
export const followScript = `<script>try{const c=new BroadcastChannel('ros-ai-plugins');c.onmessage=e=>{const to=e.data&&e.data.steer;if(typeof to!=='string'||!(to==='close'||to.startsWith('http://')||to.startsWith('https://')))return;c.postMessage({steered:to});if(to!=='close'){location.href=to;return}window.close();setTimeout(()=>{const p=document.querySelector('main p:last-of-type');if(p)p.textContent='All done. You can close this window.'},400)};setTimeout(()=>c.close(),900000)}catch{}</script>`;
