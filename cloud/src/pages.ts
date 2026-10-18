import { config } from './config.js';

const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

/** The only two pages people see: sign in, and approve the app on this computer. Plain HTML that
 * calls Better Auth's own endpoints, so there is no client bundle to build or host. */
function page(title: string, body: string, script: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · ros.ai</title><style>
:root{--bg:#f3f4f2;--card:#fff;--ink:#1d211f;--muted:#5d6560;--line:#dfe2de;--accent:#16901a;--fail:#b42318}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:32px 28px}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 18px;color:var(--muted)}
button,input{font:inherit;width:100%;border-radius:9px;padding:10px 12px}input{border:1px solid var(--line);margin-bottom:10px}
button{border:1px solid var(--line);background:#fff;cursor:pointer;margin-bottom:10px}button.primary{background:var(--ink);color:#fff;border-color:var(--ink)}
.code{font:600 26px/1.2 ui-monospace,monospace;letter-spacing:4px;text-align:center;padding:14px;border:1px dashed var(--line);border-radius:10px;margin-bottom:18px}
.error{color:var(--fail)}.done{color:var(--accent)}hr{border:0;border-top:1px solid var(--line);margin:14px 0}[hidden]{display:none}
</style></head><body><main>${body}</main><script>
const api=(path,init)=>fetch('/api/auth'+path,{credentials:'include',headers:{'Content-Type':'application/json'},...init}).then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||j.error_description||'Something went wrong.');return j;});
const say=(text,kind)=>{const el=document.getElementById('status');el.textContent=text;el.className=kind||'';};
${script}</script></body></html>`;
}

export function signInPage(next: string) {
  const providers = [config.github && 'github', config.google && 'google'].filter(Boolean) as string[];
  const social = providers.map(id => `<button data-provider="${id}">Continue with ${id === 'github' ? 'GitHub' : 'Google'}</button>`).join('');
  const email = config.emailPassword ? `${social ? '<hr>' : ''}<form id="email"><input name="email" type="email" placeholder="Email" required autocomplete="email"><input name="password" type="password" placeholder="Password (12 characters or more)" required minlength="12" autocomplete="current-password"><button class="primary">Sign in</button><button type="button" id="create">Create an account</button></form>` : '';
  const body = `<h1>Sign in to ros.ai</h1><p>Your account gives you Ros, free and hosted. Your projects stay on your computer.</p>${social}${email}${social || email ? '' : '<p class="error">No sign-in method is set up on this server yet.</p>'}<p id="status"></p>`;
  const script = `const next=${JSON.stringify(next)};
document.querySelectorAll('[data-provider]').forEach(b=>b.onclick=()=>api('/sign-in/social',{method:'POST',body:JSON.stringify({provider:b.dataset.provider,callbackURL:next})}).then(j=>location.href=j.url).catch(e=>say(e.message,'error')));
const form=document.getElementById('email');
if(form){const values=()=>Object.fromEntries(new FormData(form));
form.onsubmit=e=>{e.preventDefault();api('/sign-in/email',{method:'POST',body:JSON.stringify(values())}).then(()=>location.href=next).catch(e=>say(e.message,'error'));};
document.getElementById('create').onclick=()=>{if(!form.reportValidity())return;const v=values();api('/sign-up/email',{method:'POST',body:JSON.stringify({...v,name:v.email.split('@')[0]})}).then(()=>location.href=next).catch(e=>say(e.message,'error'));};}`;
  return page('Sign in', body, script);
}

export function devicePage(userCode: string) {
  const body = `<h1>Connect ros.ai on your computer</h1><p>Check that this code matches the one ros.ai shows, then approve.</p>
<div class="code" id="code">${escape(userCode) || '—'}</div><form id="enter" hidden><input name="code" placeholder="Code from ros.ai" required autocomplete="off"><button class="primary">Continue</button></form>
<div id="choice" hidden><button class="primary" id="approve">Approve</button><button id="deny">This isn't me</button></div><p id="status"></p>`;
  const script = `const code=${JSON.stringify(userCode)};
const enter=document.getElementById('enter'),choice=document.getElementById('choice');
enter.onsubmit=e=>{e.preventDefault();location.search='?user_code='+encodeURIComponent(new FormData(enter).get('code').trim().toUpperCase());};
(async()=>{if(!code){enter.hidden=false;return;}
const session=await api('/get-session').catch(()=>null);
if(!session){location.href='/sign-in?next='+encodeURIComponent(location.pathname+location.search);return;}
try{await api('/device?user_code='+encodeURIComponent(code));choice.hidden=false;say('Signed in as '+session.user.email+'.');}catch(e){say(e.message,'error');}
document.getElementById('approve').onclick=()=>api('/device/approve',{method:'POST',body:JSON.stringify({userCode:code})}).then(()=>{choice.hidden=true;say('Done. You can close this tab and go back to ros.ai.','done');}).catch(e=>say(e.message,'error'));
document.getElementById('deny').onclick=()=>api('/device/deny',{method:'POST',body:JSON.stringify({userCode:code})}).then(()=>{choice.hidden=true;say('Refused. Nothing was connected.');}).catch(e=>say(e.message,'error'));})();`;
  return page('Connect ros.ai', body, script);
}
