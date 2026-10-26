import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { GoogleDriveCapture, GoogleDriveFile, GoogleDriveFiles, GoogleDriveStatus } from '../shared/google-drive.js';
import type { ProjectResource } from '../shared/research.js';
import { LocalConnections } from './connections.js';
import { Store, StoreError } from './store.js';

export const GOOGLE_DRIVE_SCOPE='https://www.googleapis.com/auth/drive.readonly';
const TOKEN_URL='https://oauth2.googleapis.com/token', AUTH_URL='https://accounts.google.com/o/oauth2/v2/auth';
const API_ROOT='https://www.googleapis.com/drive/v3/', SHEETS_ROOT='https://sheets.googleapis.com/v4/', COOKIE='ros-ai-drive-oauth', CALLBACK='/api/connections/google-drive/callback';
const MAX_CSV_BYTES=500000, AUTH_TTL=10*60*1000;
const fileIdSchema=z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/u);
/** What live Sheet and Doc blocks and the agents' Drive tools may read: a file listing, one file's details or export,
 * and a spreadsheet's tabs and values. */
const READ_PATHS={drive:/^files(\/[a-zA-Z0-9_-]{1,200}(\/export)?)?$/u,sheets:/^spreadsheets\/[a-zA-Z0-9_-]{1,200}(\/values:batchGet|\/values\/[^/?#]{1,600})?$/u};
/** A refusal from Google's API, with Google's reason (SERVICE_DISABLED, cannotExportFile…) for callers that fall back. */
export class GoogleApiError extends StoreError {constructor(message:string,status:number,readonly reason:string){super(message,status);this.name='GoogleApiError';}}
const disabledReasons=new Set(['SERVICE_DISABLED','accessNotConfigured']);
export const googleApiDisabled=(error:unknown)=>error instanceof GoogleApiError&&disabledReasons.has(error.reason);
function googleMessage(api:'drive'|'sheets',status:number,reason:string,message:string){
  if(disabledReasons.has(reason))return `The Google ${api==='sheets'?'Sheets':'Drive'} API is off in the Google Cloud project behind ros.ai’s Google sign-in. Turn it on under APIs & Services › Library there.`;
  if(status===429||/rate.?limit/iu.test(reason))return 'Google is limiting requests. Try again in a minute.';
  if(status===404)return 'Google Drive has no such file, or the connected account cannot open it.';
  if(reason==='exportSizeLimitExceeded')return 'This file is too large for Google to export (more than 10 MB).';
  if(reason==='cannotExportFile'||reason==='cannotDownloadFile')return 'The file’s owner turned off downloading and copying, so Google does not hand out its content.';
  if(reason==='ACCESS_TOKEN_SCOPE_INSUFFICIENT'||reason==='insufficientPermissions')return 'The Google sign-in lacks read access to Drive. Reconnect Google Drive.';
  if(status===403)return 'The connected Google account cannot open this file.';
  if(status===400)return `Google could not read that: ${message.replace(/[\x00-\x1f\x7f]/gu,' ').slice(0,200)||'bad request'}.`;
  return `Google returned HTTP ${status}.`;
}
const credentialsSchema=z.object({clientId:z.string(),accessToken:z.string().min(1).max(10000),refreshToken:z.string().min(1).max(10000).optional(),expiresAt:z.number().finite(),scope:z.string().max(4000),connectedAt:z.string()}).strict();
const clientSchema=z.object({clientId:z.string().trim().min(1).max(1000).regex(/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/u),clientSecret:z.string().trim().min(1).max(4000)}).strict();
type Credentials=z.infer<typeof credentialsSchema>;
type Pending={verifier:string;cookieHash:string;redirectUri:string;expiresAt:number};
export type GoogleDriveOptions={dataDir:string;clientId?:string;clientSecret?:string;port?:number;fetch?:typeof fetch;now?:()=>number};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const secureEqual=(left:string,right:string)=>left.length===right.length&&timingSafeEqual(Buffer.from(left),Buffer.from(right));
const fileUrl=(fileId:string)=>`https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
function browserNonce(req:Request):string {
  const item=(req.headers.cookie??'').split(';').map(value=>value.trim()).find(value=>value.startsWith(`${COOKIE}=`));
  const value=item?.slice(COOKIE.length+1)??'';return /^[a-zA-Z0-9_-]{43}$/u.test(value)?value:'';
}
function cookie(res:Response,value:string,maxAge:number){res.cookie(COOKIE,value,{httpOnly:true,sameSite:'lax',path:CALLBACK,maxAge,secure:false});}
async function boundedBody(response:globalThis.Response,maximum:number):Promise<Uint8Array>{
  const declared=response.headers.get('content-length');if(declared&&Number(declared)>maximum){await response.body?.cancel();throw new StoreError('Google response exceeds the allowed size.');}
  if(!response.body)return new Uint8Array();
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>maximum){await reader.cancel();throw new StoreError('Google response exceeds the allowed size.');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const data=new Uint8Array(length);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}return data;
}
const jsonBody=async(response:globalThis.Response,maximum=100000):Promise<unknown>=>{
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await boundedBody(response,maximum))) as unknown;}
  catch(cause){if(cause instanceof StoreError)throw cause;throw new StoreError('Google returned an unreadable response. No file was imported.',503);}
};

/** OAuth is user initiated. Tokens never leave this server module. Drive access
 * uses fixed Google endpoints and read-only GETs, then an explicit local copy. */
export class GoogleDriveConnection {
  private clientId:string;private clientSecret:string;private readonly port:number;private configSource:GoogleDriveStatus['configurationSource'];
  private readonly fetcher:typeof fetch;private readonly clock:()=>number;private readonly credentialPath:string;
  private readonly clientPath:string;
  private credentials?:Credentials;private pending=new Map<string,Pending>();private refreshing?:Promise<string>;
  private lastError='';private reconnect=false;private epoch=0;
  constructor(options:GoogleDriveOptions){
    this.clientId=(options.clientId??process.env.ROS_GOOGLE_CLIENT_ID??'').trim();this.clientSecret=(options.clientSecret??process.env.ROS_GOOGLE_CLIENT_SECRET??'').trim();
    this.configSource=this.clientId||this.clientSecret?'environment':'missing';
    this.port=options.port??Number(process.env.ROS_PORT??4310);this.fetcher=options.fetch??fetch;this.clock=options.now??Date.now;
    this.credentialPath=join(resolve(options.dataDir),'connections','google-drive.json');
    this.clientPath=join(resolve(options.dataDir),'connections','google-drive-client.json');
    if(existsSync(this.clientPath)){
      try{const saved=clientSchema.parse(this.readPrivate(this.clientPath));this.clientId=saved.clientId;this.clientSecret=saved.clientSecret;this.configSource='local-private-file';}
      catch{this.clientId='';this.clientSecret='';this.configSource='missing';this.lastError='The local Google OAuth app configuration could not be loaded safely. Save its client settings again.';}
    }
    if(existsSync(this.credentialPath)){
      try{
        const saved=credentialsSchema.parse(this.readPrivate(this.credentialPath));if(saved.clientId===this.clientId)this.credentials=saved;else this.lastError='The configured OAuth client changed. Connect Google Drive again.';
      }catch{this.lastError='Google Drive credentials could not be loaded safely. Reconnect to replace the private credential file.';this.reconnect=true;}
    }
  }
  private readPrivate(path:string):unknown{
    const directory=resolve(path,'..');if(lstatSync(directory).isSymbolicLink())throw new Error('Private credential directory cannot be redirected.');
    const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||info.size>40000)throw new Error('Private credential file permissions are invalid.');
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{if(fstatSync(fd).size>40000)throw new Error('Private credential file is too large.');return JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
  }
  private origin(value?:string):string{
    const origin=new URL(value??`http://127.0.0.1:${this.port}`);
    if(origin.protocol!=='http:'||!['127.0.0.1','localhost'].includes(origin.hostname)||Number(origin.port||80)!==this.port||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new StoreError('Google Drive OAuth returns only to this local ros.ai server.');
    return origin.origin;
  }
  status(origin?:string):GoogleDriveStatus{
    if(this.credentials&&this.credentials.expiresAt<=this.clock()&&!this.credentials.refreshToken){this.reconnect=true;this.lastError='Google’s saved access token expired without a refresh token. Connect again.';}
    const missing=[...(!this.clientId?['ROS_GOOGLE_CLIENT_ID']:[]),...(!this.clientSecret?['ROS_GOOGLE_CLIENT_SECRET']:[])];
    const configured=!missing.length,connected=configured&&Boolean(this.credentials)&&!this.reconnect;
    const callbackUri=`${this.origin(origin)}${CALLBACK}`;
    return {provider:'google-drive',configured,connected,available:connected,state:!configured?'needs-setup':this.reconnect?'reconnect-required':connected?'connected':'disconnected',
      detail:!configured?'Google Drive needs an OAuth application configuration before login.':this.reconnect?'Reconnect Google Drive. The saved grant is unavailable or expired.':connected?'Connected locally. Google Sheets and Docs show live on the canvas, agents read Drive, and CSV files copy into projects; Drive files stay unchanged.':'Ready for you to sign in with Google and approve read-only Drive access.',scope:GOOGLE_DRIVE_SCOPE,scopeDescription:'Google consent grants read-only access to Drive files. ros.ai lists files, reads Google Sheets and Docs for live blocks and agents, and copies the CSV files you choose; it cannot upload, edit, share or delete Google files.',callbackUri,configurationSource:this.configSource,...(this.credentials?{connectedAt:this.credentials.connectedAt}:{}),...(this.lastError?{lastError:this.lastError}:{}),
      setup:{missing,steps:['In your Google Cloud project, enable the Google Drive API and the Google Sheets API, and configure the OAuth consent screen. Add your own Google account as a test user if the app is in Testing.','Create an OAuth client of type Web application for this local installation.',`Register this exact authorized redirect URI: ${callbackUri}`,'Save its client ID and secret in this connection’s local app settings. They stay in an owner-only private file on this computer. Alternatively, set ROS_GOOGLE_CLIENT_ID and ROS_GOOGLE_CLIENT_SECRET in ignored .env.local and restart.','Select Connect Google Drive here, complete Google login and review its read-only permission. No login is performed automatically.'],documentation:[{title:'Google OAuth web-server flow',url:'https://developers.google.com/identity/protocols/oauth2/web-server'},{title:'Choose Drive scopes',url:'https://developers.google.com/workspace/drive/api/guides/api-specific-auth'},{title:'OAuth PKCE and loopback redirects',url:'https://developers.google.com/identity/protocols/oauth2/native-app'}]}};
  }
  configure(supplied:unknown,origin?:string){
    const client=clientSchema.safeParse(supplied);if(!client.success)throw new StoreError('Enter a Google OAuth client ID ending in .apps.googleusercontent.com and its client secret.');
    this.writePrivate(this.clientPath,client.data);
    const changed=this.clientId!==client.data.clientId||this.clientSecret!==client.data.clientSecret;
    this.clientId=client.data.clientId;this.clientSecret=client.data.clientSecret;this.configSource='local-private-file';
    if(changed)this.disconnect();
    return this.status(origin);
  }
  begin(origin:string){
    if(!this.status(origin).configured)throw new StoreError('Set ROS_GOOGLE_CLIENT_ID and ROS_GOOGLE_CLIENT_SECRET in .env.local, register the displayed local callback URI, then restart ros.ai.',503);
    for(const [state,item]of this.pending)if(item.expiresAt<this.clock())this.pending.delete(state);
    if(this.pending.size>=50)throw new StoreError('Too many pending Google logins. Wait ten minutes before trying again.',429);
    const state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url'),redirectUri=`${this.origin(origin)}${CALLBACK}`;
    this.pending.set(state,{verifier,cookieHash:digest(nonce),redirectUri,expiresAt:this.clock()+AUTH_TTL});
    const url=new URL(AUTH_URL);url.search=new URLSearchParams({client_id:this.clientId,redirect_uri:redirectUri,response_type:'code',scope:GOOGLE_DRIVE_SCOPE,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',access_type:'offline',prompt:'consent'}).toString();
    return {url:url.href,nonce};
  }
  async callback(query:unknown,nonce:string,origin:string){
    const parsed=z.object({state:z.string().max(200),code:z.string().max(10000).optional(),error:z.string().max(200).optional()}).passthrough().parse(query);
    const item=this.pending.get(parsed.state);
    if(!item||item.expiresAt<this.clock()||!nonce||!secureEqual(item.cookieHash,digest(nonce))||item.redirectUri!==`${this.origin(origin)}${CALLBACK}`)throw new StoreError('Google login state expired or belongs to another browser. Start Connect again.',400);
    this.pending.delete(parsed.state);
    if(parsed.error){this.lastError=parsed.error==='access_denied'?'Google Drive connection was cancelled. Your existing local research is unchanged.':'Google did not authorize this connection. Review the OAuth client setup and try again.';throw new StoreError(this.lastError,400);}
    if(!parsed.code)throw new StoreError('Google did not return an authorization code. Start Connect again.',400);
    const epoch=this.epoch;
    const result=await this.exchange(new URLSearchParams({client_id:this.clientId,client_secret:this.clientSecret,code:parsed.code,code_verifier:item.verifier,redirect_uri:item.redirectUri,grant_type:'authorization_code'}));
    if(epoch!==this.epoch)throw new StoreError('This Google connection was disconnected while login was pending. Start Connect again.',409);
    const scope=String(result.scope??'');
    if(!scope.split(' ').includes(GOOGLE_DRIVE_SCOPE))throw new StoreError('Google Drive read-only content permission was not granted. Reconnect and review the permission.',403);
    // A new login may select another Google account. Never pair its access
    // token with a refresh token retained from an earlier account.
    const credentials=credentialsSchema.parse({clientId:this.clientId,accessToken:result.access_token,refreshToken:result.refresh_token,expiresAt:this.clock()+Number(result.expires_in)*1000,scope,connectedAt:new Date(this.clock()).toISOString()});
    this.persist(credentials);this.credentials=credentials;this.reconnect=false;this.lastError='';return this.status(origin);
  }
  private persist(credentials:Credentials){this.writePrivate(this.credentialPath,credentials);}
  private writePrivate(path:string,value:unknown){
    const directory=resolve(path,'..');mkdirSync(directory,{recursive:true,mode:0o700});
    if(lstatSync(directory).isSymbolicLink())throw new StoreError('Google credential storage cannot be a redirected directory.');
    if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new StoreError('Google credential storage cannot be a symbolic link.');
    const temp=join(directory,`google-drive-${randomUUID()}.tmp`);
    try{writeFileSync(temp,JSON.stringify(value),{flag:'wx',mode:0o600});renameSync(temp,path);}finally{if(existsSync(temp))unlinkSync(temp);}
  }
  private async exchange(body:URLSearchParams):Promise<Record<string,unknown>>{
    let response:globalThis.Response;
    try{response=await this.fetcher(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body.toString(),redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new StoreError('Google OAuth could not be reached. Check this computer’s connection and try Connect again.',503);}
    let value:unknown;try{value=await jsonBody(response,40000);}catch{throw new StoreError('Google returned an unreadable OAuth response. Start Connect again.',503);}
    if(!response.ok){const error=value&&typeof value==='object'&&'error'in value?String(value.error):'';if(error==='invalid_grant'){this.reconnect=true;this.lastError='Google authorization expired or was revoked. Connect Google Drive again.';}throw new StoreError(error==='invalid_grant'?this.lastError:error==='invalid_client'?'Google rejected the OAuth client. Check the server client ID/secret and callback URI.':'Google could not authorize this connection. Check OAuth setup and reconnect.',503);}
    const token=z.object({access_token:z.string().min(1).max(10000),refresh_token:z.string().min(1).max(10000).optional(),expires_in:z.number().int().positive().max(86400*365),token_type:z.string().refine(value=>value.toLowerCase()==='bearer'),scope:z.string().max(4000).optional()}).passthrough().safeParse(value);
    if(!token.success)throw new StoreError('Google returned an unsupported OAuth token response. Reconnect.',503);
    return token.data;
  }
  private async token():Promise<string>{
    if(!this.status().connected||!this.credentials)throw new StoreError(this.reconnect?'Google authorization is unavailable. Reconnect Google Drive.':'Connect Google Drive before browsing files.',503);
    if(this.credentials.expiresAt>this.clock()+60000)return this.credentials.accessToken;
    if(this.refreshing)return this.refreshing;
    if(!this.credentials.refreshToken){this.reconnect=true;throw new StoreError('Google’s saved access token expired without a refresh token. Connect again.',503);}
    const previous=this.credentials,epoch=this.epoch;
    this.refreshing=(async()=>{
      const result=await this.exchange(new URLSearchParams({client_id:this.clientId,client_secret:this.clientSecret,refresh_token:previous.refreshToken!,grant_type:'refresh_token'}));
      if(epoch!==this.epoch)throw new StoreError('Google Drive was disconnected while refreshing. Reconnect before browsing.',409);
      const credentials=credentialsSchema.parse({...previous,accessToken:result.access_token,refreshToken:result.refresh_token??previous.refreshToken,expiresAt:this.clock()+Number(result.expires_in)*1000,scope:result.scope??previous.scope});
      if(!credentials.scope.split(' ').includes(GOOGLE_DRIVE_SCOPE)){this.reconnect=true;throw new StoreError('Google no longer grants read-only Drive content access. Reconnect.',403);}
      this.persist(credentials);this.credentials=credentials;return credentials.accessToken;
    })();
    try{return await this.refreshing;}finally{this.refreshing=undefined;}
  }
  private async drive(path:string,query:URLSearchParams):Promise<globalThis.Response>{
    if(!/^(files|files\/[a-zA-Z0-9_-]{1,200})$/u.test(path))throw new StoreError('Unsupported Google Drive operation.');
    const token=await this.token(),url=new URL(path,API_ROOT);url.search=query.toString();
    let response:globalThis.Response;try{response=await this.fetcher(url.href,{method:'GET',headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new StoreError('Google Drive could not be reached. No file was imported.',503);}
    if(!response.ok){await response.body?.cancel();if(response.status===401){this.reconnect=true;this.lastError='Google Drive rejected the saved authorization. Reconnect.';}throw new StoreError(response.status===401?this.lastError:response.status===403?'Google Drive does not permit reading this file. Check its permission and download restrictions.':response.status===404?'This Google Drive file is unavailable to the connected account.':'Google Drive request failed. Try browsing again; no file was imported.',response.status===404?404:503);}
    return response;
  }
  /** A read of Google's Drive or Sheets API for live Sheet and Doc blocks and the agents' Drive tools: fixed hosts,
   * GET only, the read-only Drive scope. Google's refusals come back as GoogleApiError with Google's reason. */
  async read(api:'drive'|'sheets',path:string,query:URLSearchParams,maximum=4_000_000,signal?:AbortSignal):Promise<Uint8Array>{
    if(!READ_PATHS[api].test(path))throw new StoreError('Unsupported Google operation.');
    const token=await this.token(),url=new URL(path,api==='drive'?API_ROOT:SHEETS_ROOT);url.search=query.toString();
    const timeout=AbortSignal.timeout(30000);
    let response:globalThis.Response;
    try{response=await this.fetcher(url.href,{method:'GET',headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});}
    catch(cause){if(signal?.aborted)throw cause;throw new StoreError('Google could not be reached. Check this computer’s connection.',503);}
    if(!response.ok){
      const body=await jsonBody(response,40000).catch(()=>null) as {error?:{message?:unknown;status?:unknown;errors?:{reason?:unknown}[];details?:{reason?:unknown}[]}}|null;
      const reason=String(body?.error?.details?.find(item=>item?.reason)?.reason??body?.error?.errors?.find(item=>item?.reason)?.reason??body?.error?.status??'').slice(0,80);
      if(response.status===401){this.reconnect=true;this.lastError='Google rejected the saved authorization. Reconnect Google Drive.';throw new GoogleApiError(this.lastError,503,'unauthorized');}
      throw new GoogleApiError(googleMessage(api,response.status,reason,String(body?.error?.message??'')),[400,403,404,429].includes(response.status)?response.status:502,reason);
    }
    return boundedBody(response,maximum);
  }
  private file(value:unknown):GoogleDriveFile{
    const body=z.object({id:fileIdSchema,name:z.string().min(1).max(1000),mimeType:z.string().max(500),size:z.string().regex(/^\d+$/u).optional(),modifiedTime:z.string().max(200).optional(),version:z.string().max(200).optional(),md5Checksum:z.string().max(200).optional(),capabilities:z.object({canDownload:z.boolean().optional()}).optional()}).passthrough().parse(value);
    return {id:body.id,name:body.name,mimeType:body.mimeType,...(body.size?{size:Number(body.size)}:{}),...(body.modifiedTime?{modifiedTime:body.modifiedTime}:{}),...(body.version?{version:body.version}:{}),...(body.md5Checksum?{md5Checksum:body.md5Checksum}:{}),canDownload:body.capabilities?.canDownload===true,url:fileUrl(body.id)};
  }
  async files(query='',pageToken?:string):Promise<GoogleDriveFiles>{
    z.string().max(200).parse(query);if(pageToken)z.string().max(2000).parse(pageToken);
    const escaped=query.replaceAll('\\','\\\\').replaceAll("'","\\'");
    const filters=`trashed = false and (mimeType = 'text/csv' or name contains '.csv' or name contains '.CSV')${query?` and name contains '${escaped}'`:''}`;
    const params=new URLSearchParams({q:filters,pageSize:'50',spaces:'drive',orderBy:'modifiedTime desc',fields:'nextPageToken,files(id,name,mimeType,size,modifiedTime,version,md5Checksum,capabilities(canDownload))',...(pageToken?{pageToken}:{})});
    const result=z.object({files:z.array(z.unknown()).max(50).default([]),nextPageToken:z.string().max(2000).optional()}).passthrough().parse(await jsonBody(await this.drive('files',params),250000));
    return {files:result.files.map(value=>this.file(value)).filter(file=>!file.mimeType.startsWith('application/vnd.google-apps.')&&(file.mimeType==='text/csv'||file.name.toLowerCase().endsWith('.csv'))),...(result.nextPageToken?{nextPageToken:result.nextPageToken}:{})};
  }
  async capture(store:Store,projectId:string,supplied:unknown):Promise<{resource:ProjectResource;provenance:GoogleDriveCapture}>{
    store.getProject(projectId);
    const body=z.object({fileId:fileIdSchema,expectedModifiedTime:z.string().max(200).optional(),expectedVersion:z.string().max(200).optional()}).strict().parse(supplied);
    const metadataParams=new URLSearchParams({fields:'id,name,mimeType,size,modifiedTime,version,md5Checksum,capabilities(canDownload)',supportsAllDrives:'true'});
    const file=this.file(await jsonBody(await this.drive(`files/${body.fileId}`,metadataParams)));
    if(!(file.name.toLowerCase().endsWith('.csv')||file.mimeType==='text/csv')||file.mimeType.startsWith('application/vnd.google-apps.'))throw new StoreError('Choose a saved CSV file. Google Docs/Sheets export is not implemented.');
    if(!file.canDownload)throw new StoreError('Google Drive does not allow this file to be downloaded.',403);
    if(file.size!==undefined&&file.size>MAX_CSV_BYTES)throw new StoreError('Choose a CSV no larger than 500,000 bytes.');
    if((body.expectedModifiedTime&&body.expectedModifiedTime!==file.modifiedTime)||(body.expectedVersion&&body.expectedVersion!==file.version))throw new StoreError('The Drive file changed since it was listed. Browse again before capturing its current version.',409);
    const data=await boundedBody(await this.drive(`files/${body.fileId}`,new URLSearchParams({alt:'media',supportsAllDrives:'true'})),MAX_CSV_BYTES);
    let content:string;try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);}catch{throw new StoreError('The selected CSV is not UTF-8 text. Save a UTF-8 CSV before importing.');}
    if(!data.length||content.includes('\0'))throw new StoreError('Choose a non-empty UTF-8 CSV without binary data.');
    const after=this.file(await jsonBody(await this.drive(`files/${body.fileId}`,metadataParams)));
    if(file.version!==after.version||file.modifiedTime!==after.modifiedTime||file.size!==after.size||file.md5Checksum!==after.md5Checksum)throw new StoreError('The Drive file changed while capturing. Browse its current version and try again.',409);
    if(file.md5Checksum&&createHash('md5').update(data).digest('hex')!==file.md5Checksum)throw new StoreError('The captured bytes do not match the selected Drive file. Capture again after checking its current version.',409);
    const provenance:GoogleDriveCapture={provider:'google-drive',fileId:file.id,name:file.name,mimeType:file.mimeType,...(file.modifiedTime?{modifiedTime:file.modifiedTime}:{}),...(file.version?{version:file.version}:{}),...(file.md5Checksum?{md5Checksum:file.md5Checksum}:{}),contentHash:digest(content),capturedAt:new Date(this.clock()).toISOString(),permission:'read-only explicit CSV capture',url:file.url};
    return store.atomic(()=>{
      const connections=new LocalConnections(store),resource=connections.addResource(projectId,{mode:'copy',name:file.name.slice(0,160),fileName:file.name.toLowerCase().endsWith('.csv')?file.name:'drive-capture.csv',content});
      const copied=store.record<Record<string,unknown>>('resource-copy',resource.id)!;store.saveRecord('resource-copy',resource.id,projectId,{...copied,url:file.url});
      store.saveRecord('google-drive-capture',resource.id,projectId,provenance);
      return {resource:{...resource,url:file.url},provenance};
    });
  }
  disconnect(){this.epoch++;this.pending.clear();this.credentials=undefined;this.reconnect=false;this.lastError='';if(existsSync(this.credentialPath))unlinkSync(this.credentialPath);return this.status();}
  loginFailed(cause:unknown){this.lastError=cause instanceof StoreError?cause.message:'Google login could not be completed. Check the OAuth client setup and start Connect again.';}
  shutdown(){this.pending.clear();this.epoch++;}
}

/** Mount only in the local private service after its host/origin/JSON middleware. */
export function attachGoogleDriveRoutes(app:Express,drive:GoogleDriveConnection,store:Store){
  const origin=(req:Request)=>`http://${req.headers.host}`;
  const json=(req:Request)=>{if(!req.is('application/json'))throw new StoreError('Connection changes require JSON requests.',415);};
  app.get('/api/connections/google-drive',(req,res)=>res.json(drive.status(origin(req))));
  app.put('/api/connections/google-drive/config',(req,res)=>{json(req);res.json(drive.configure(req.body,origin(req)));});
  app.post('/api/connections/google-drive/connect',(req,res)=>{json(req);z.object({}).strict().parse(req.body??{});const started=drive.begin(origin(req));cookie(res,started.nonce,AUTH_TTL);res.json({authorizationUrl:started.url});});
  app.get(CALLBACK,async(req,res)=>{try{await drive.callback(req.query,browserNonce(req),origin(req));cookie(res,'',0);res.redirect(303,'/?googleDrive=connected');}catch(cause){drive.loginFailed(cause);cookie(res,'',0);res.redirect(303,'/?googleDrive=error');}});
  app.post('/api/connections/google-drive/disconnect',(req,res)=>{json(req);z.object({}).strict().parse(req.body??{});res.json(drive.disconnect());});
  app.get('/api/connections/google-drive/files',async(req,res)=>{const query=z.object({query:z.string().max(200).default(''),pageToken:z.string().max(2000).optional()}).strict().parse(req.query);res.json(await drive.files(query.query,query.pageToken));});
  app.post('/api/projects/:id/google-drive/import',async(req,res)=>{json(req);res.status(201).json(await drive.capture(store,z.string().min(1).max(128).parse(req.params.id),req.body));});
}
