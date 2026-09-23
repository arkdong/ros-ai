import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AssistantFocus, AssistantState } from '../shared/assistant.js';
import { Store, StoreError } from './store.js';
import { createApp } from './app.js';
import { ModelSettings } from './model-settings.js';
import { TutorialService } from './tutorial.js';
import { attachWaitlistRoutes, type Waitlist } from './waitlist.js';

const disabledReason = 'This public demo uses saved evidence. Fresh execution and paid model/search calls require a separately configured and authorized research server.';
const cookieName = 'ros_ai_demo';
const idPattern = /^[a-f0-9]{64}$/;
const routeId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const disabled = ():never => { throw new StoreError(disabledReason,403); };

// Only these existing local operations may reach a visitor's private Store.
// Host filesystem connectors, provider usage, arbitrary execution and account
// configuration never enter the public route surface.
function permitted(method:string,path:string):boolean {
  const project = '/api/projects/[a-zA-Z0-9_-]+';
  const rules:Record<string,RegExp[]> = {
    GET:[/^\/api\/(projects(?:\/trash)?|connections|demo-scenarios)$/,
      new RegExp(`^${project}(?:/(?:demo-session|policy|research|assistant|models|resources|reviews))?$`),
      new RegExp(`^${project}/resources/[a-zA-Z0-9_-]+$`)],
    POST:[/^\/api\/(demo-sessions|projects)$/,
      new RegExp(`^${project}/(?:mutations|undo|redo|inputs|highlights|trash|restore|assistant/focus|demo-session/advance)$`),
      new RegExp(`^${project}/resources/[a-zA-Z0-9_-]+/use$`)],
    PATCH:[new RegExp(`^${project}/(?:models|highlights/[a-zA-Z0-9_-]+)$`)],
    DELETE:[new RegExp(`^${project}/(?:inputs|highlights)/[a-zA-Z0-9_-]+$`)],
  };
  return rules[method]?.some(rule => rule.test(path)) ?? false;
}

function savedAssistant(store:Store,projectId:string):AssistantState {
  const detail = store.detail(projectId), session = new TutorialService(store,undefined,{publicDemo:true}).read(projectId);
  const savedFocus = store.record<AssistantFocus>('assistant-focus',projectId);
  const focus:AssistantFocus = savedFocus?.nodeId && detail.project.canvas.nodes.some(node => node.id === savedFocus.nodeId) ? savedFocus : {nodeId:null};
  const question = detail.project.canvas.nodes.find(node => node.parentId === session?.stages[0]?.nodeId)?.description ?? null;
  return { projectId,focus,memory:{originalQuestion:question,questionHistory:[],decisions:[],findings:[],hypotheses:[],gaps:[]},
    outline:detail.project.canvas.nodes.map(node => ({id:node.id,nodeId:node.id,title:node.title,summary:node.description,
      kind:'direction',references:[{kind:'node',id:node.id,nodeId:node.id,label:node.title}]})),
    turns:[],messages:detail.messages.filter(message => message.nodeId === null),activeTurnId:null,modelAvailable:false,searchAvailable:false };
}

function visitorApp(store:Store):Express {
  const app = express(), models = new ModelSettings(store);
  app.use(express.json({limit:'1mb'}));
  app.get('/api/projects/:id/research',(req,res) => {store.getProject(routeId.parse(req.params.id));res.json([]);});
  app.get('/api/projects/:id/assistant',(req,res) => res.json(savedAssistant(store,routeId.parse(req.params.id))));
  app.post('/api/projects/:id/assistant/focus',(req,res) => {
    const projectId = routeId.parse(req.params.id), detail = store.detail(projectId);
    const focus = z.object({nodeId:routeId.nullable(),artifactId:routeId.nullable().optional()}).strict().parse(req.body);
    if (focus.nodeId && !detail.project.canvas.nodes.some(node => node.id === focus.nodeId)) throw new StoreError('Choose a note in this workspace.');
    if (focus.artifactId && !detail.artifacts.some(artifact => artifact.id === focus.artifactId)) throw new StoreError('Choose an artifact in this workspace.');
    store.saveRecord('assistant-focus',projectId,projectId,focus);
    res.json(savedAssistant(store,projectId));
  });
  const publicSettings = (value:ReturnType<ModelSettings['read']>) => ({...value,providers:value.providers.map(provider => ({...provider,configured:false}))});
  app.get('/api/projects/:id/models',(req,res) => res.json(publicSettings(models.read(routeId.parse(req.params.id)))));
  app.patch('/api/projects/:id/models',(req,res) => res.json(publicSettings(models.update(routeId.parse(req.params.id),req.body))));
  app.post(['/api/demo-sessions','/api/projects'],(_req,_res,next) => {
    if (store.listProjects().length + store.listTrashedProjects().length >= 5) throw new StoreError('This demo browser session can keep up to five workspaces. Continue one of your existing demonstrations.',409);
    next();
  });
  app.post('/api/projects',(req,_res,next) => {
    if (req.body?.start === 'demo') throw new StoreError('Choose the banking scenario from Demo mode. The older local weather starter is not bundled in this public website.');
    next();
  });
  app.use(createApp(store,{chat:disabled,startRun:disabled,cancelRun:disabled,retryRun:disabled,
    connectionStatuses:() => [{provider:'public-demo',configured:false,detail:disabledReason,limitUsd:0,accountedUsd:0}]},
    undefined,undefined,undefined,{publicDemo:true}));
  return app;
}

export function createPublicDemoApp(options:{dataDir:string;origin:string;maxSessions?:number;waitlist?:Waitlist}) {
  const origin = new URL(options.origin);
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !(loopback && origin.protocol === 'http:')) throw new Error('Public demo origin must use HTTPS, except local preview.');
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('ROS_PUBLIC_ORIGIN must be a plain origin, without a path or credentials.');
  const directory = join(options.dataDir,'public-visitors');
  mkdirSync(directory,{recursive:true,mode:0o700});
  const maxSessions = options.maxSessions ?? 500;
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error('Public demo session capacity must be a positive integer.');
  const sessions = new Map<string,{store:Store;app:Express}>();
  const ensureVisitor = (req:Request,res:Response):string|null => {
    const existing = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
    if (existing && idPattern.test(existing) && existsSync(join(directory,existing))) return existing;
    if (readdirSync(directory).filter(name => idPattern.test(name)).length >= maxSessions) {
      res.status(503).json({error:'The demonstration has reached its visitor capacity. Existing browser sessions remain available.'});
      return null;
    }
    const sessionId = randomBytes(32).toString('hex');
    mkdirSync(join(directory,sessionId),{mode:0o700});
    res.cookie(cookieName,sessionId,{httpOnly:true,sameSite:'strict',secure:origin.protocol === 'https:',path:'/',maxAge:7*24*60*60*1000});
    return sessionId;
  };
  const app = express();
  app.disable('x-powered-by');
  app.get('/api/health',(_req,res) => res.json({ok:true,app:'ros.ai',mode:'public-demo'}));
  app.use((req,res,next) => {
    if (req.headers.host !== origin.host) return res.status(403).json({error:'This public demo accepts requests only on its configured domain.'});
    if (req.headers.origin && req.headers.origin !== origin.origin) return res.status(403).json({error:'Cross-origin requests are not permitted.'});
    if (req.path.startsWith('/api/') && !['GET','HEAD'].includes(req.method) && (req.headers.origin !== origin.origin || !req.is('application/json')))
      return res.status(403).json({error:'Changes must come from this demo website as JSON requests.'});
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    next();
  });
  if (options.waitlist) attachWaitlistRoutes(app, options.waitlist, { origin: origin.origin });
  // Public visitors see early access first; the research demo has its own entry.
  app.get('/',(_req,res) => res.redirect(302, '/waitlist'));
  // Establish the browser identity with the document, before its JavaScript
  // starts parallel catalog/project requests without an existing cookie.
  app.get('/app',(req,res,next) => { if (ensureVisitor(req,res)) next(); });
  app.use('/api',(req,res,next) => {
    res.setHeader('Cache-Control','no-store');
    const path = `/api${req.path}`;
    if (!permitted(req.method,path)) return res.status(403).json({error:disabledReason});
    const sessionId = ensureVisitor(req,res);
    if (!sessionId) return;
    let session = sessions.get(sessionId);
    if (!session) {
      const store = new Store(join(directory,sessionId));
      session = {store,app:visitorApp(store)};
      sessions.set(sessionId,session);
      // There are no background executors in this mode, so an idle connection
      // can close safely; its workspace remains on the persistent volume.
      if (sessions.size > 32) {
        const oldest = sessions.keys().next().value!;
        sessions.get(oldest)!.store.close();sessions.delete(oldest);
      }
    } else {sessions.delete(sessionId);sessions.set(sessionId,session);}
    // The child app owns normal /api paths; this middleware is mounted at /api.
    const previousUrl = req.url;
    req.url = `/api${previousUrl}`;
    session.app(req,res,error => {req.url = previousUrl;next(error);});
  });
  return {app,close:() => {for (const session of sessions.values()) session.store.close();sessions.clear();}};
}
