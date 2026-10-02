import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { config } from './config';
import { openDatabase,migrate,Serial,audit,type Database } from './db';
import { Jobs } from './jobs';
import { Chain } from './chain';
import { Providers } from './providers';
import { Engine } from './engine';
import { challenge,verify,sessionPlayer,hashSession } from './auth';
import { RULES } from '../shared/policy';

const COOKIE='ticksy_session';
const receipt=(row:any)=>({...row.data,id:row.id,winner:row.winner,kind:row.kind,amountMicros:String(row.amount_micros),signature:row.signature,mint:row.mint,createdAt:Number(row.created_at)});
const publicRound=(row:any)=>row?{id:row.id,number:Number(row.number),...row.data,snapshot:undefined,beacon:undefined}:null;
export async function createApp(options:{db?:Database;chain?:Chain;providers?:Providers;engine?:Engine;timers?:boolean}={}){
 const db=options.db??await openDatabase();await migrate(db);const serial=new Serial(),jobs=new Jobs(db),chain=options.chain??new Chain(jobs),providers=options.providers??new Providers(chain,jobs),engine=options.engine??new Engine(db,chain,providers);await engine.init();
 const app=Fastify({logger:false,bodyLimit:16_384,trustProxy:config.TRUST_PROXY_HOPS?(_address:string,hop:number)=>hop<config.TRUST_PROXY_HOPS:false});
 await app.register(cookie);await app.register(rateLimit,{max:120,timeWindow:'1 minute'});
 app.addHook('onRequest',async(req,reply)=>{
   reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','strict-origin-when-cross-origin').header('X-Frame-Options','DENY');
   if(req.url.startsWith('/api/'))reply.header('Cache-Control','no-store');
   if(!['GET','HEAD','OPTIONS'].includes(req.method)&&((req.headers.origin&&req.headers.origin!==config.APP_ORIGIN)||req.headers['sec-fetch-site']==='cross-site'))return reply.code(403).send({error:'Request origin is not allowed'});
 });
 const owner=async(req:any)=>{const user=await sessionPlayer(db,req.cookies[COOKIE]);if(!user?.owner)throw Object.assign(new Error('Owner wallet authentication required'),{statusCode:403});return user;};
 const route=(method:'get'|'post',path:string,handler:(req:any,reply:any)=>Promise<any>)=>app[method](path,async(req,reply)=>serial.run(()=>handler(req,reply)));
 app.get('/api/health',async()=>({ok:true,brand:'Ticksy',spendingEnabled:config.live}));
 route('get','/api/session',async req=>sessionPlayer(db,req.cookies[COOKIE]));
 route('post','/api/auth/challenge',async req=>{const b=z.object({wallet:z.string().min(32).max(44)}).parse(req.body);return challenge(db,b.wallet);});
 route('post','/api/auth/verify',async(req,reply)=>{const b=z.object({id:z.string().uuid(),signature:z.string().min(60).max(128)}).parse(req.body);const result=await verify(db,b.id,b.signature);reply.setCookie(COOKIE,result.token,{httpOnly:true,secure:config.APP_ORIGIN.startsWith('https:'),sameSite:'strict',path:'/',maxAge:86400});return{wallet:result.wallet};});
 route('post','/api/auth/logout',async(req,reply)=>{if(req.cookies[COOKIE])await db.query('DELETE FROM sessions WHERE id=$1',[hashSession(req.cookies[COOKIE])]);reply.clearCookie(COOKIE,{path:'/'});return{ok:true};});
 route('get','/api/overview',async()=>{const row=await engine.active();const recent=(await db.query('SELECT * FROM payouts ORDER BY created_at DESC LIMIT 6')).rows;const count=(await db.query('SELECT COUNT(*)::int AS n FROM payouts')).rows[0];
   return{brand:'Ticksy',domain:'ticksy.pro',coinMint:config.MEMECOIN_MINT||null,treasury:{...engine.view,paused:engine.settings.paused,spendingEnabled:config.live},activeRound:row&&row.data.commitSignature?publicRound(row):null,packs:packViews(engine),rewardCount:count.n,recent:recent.map(receipt)};});
 route('get','/api/treasury',async()=>({...engine.view,address:config.FEE_RECIPIENT||null,rules:RULES}));
 route('get','/api/packs',async()=>({packs:packViews(engine)}));
 route('get','/api/leaderboard',async()=>({entries:(await db.query("SELECT winner AS wallet,COUNT(*) FILTER(WHERE kind='watch')::int AS watches,COALESCE(SUM(amount_micros) FILTER(WHERE kind='usdc'),0)::text AS usdc FROM payouts GROUP BY winner ORDER BY watches DESC,COALESCE(SUM(amount_micros) FILTER(WHERE kind='usdc'),0) DESC,winner LIMIT 200")).rows.map(x=>({wallet:x.wallet,watches:x.watches,usdcMicros:x.usdc}))}));
 route('get','/api/profiles/:wallet',async req=>{const wallet=new PublicKey(req.params.wallet).toBase58();const eligibility=await chain.eligibility(wallet);const latest=(await db.query("SELECT data FROM rounds WHERE data->>'snapshot' IS NOT NULL ORDER BY number DESC LIMIT 1")).rows[0]?.data;const holders=latest?.snapshot?.holders??[];const h=holders.find((x:any)=>x.wallet===wallet);return{wallet,eligibility,snapshotOdds:holders.length?(h?.weight??0)/holders.reduce((sum:number,x:any)=>sum+x.weight,0):null,rewards:(await db.query('SELECT * FROM payouts WHERE winner=$1 ORDER BY created_at DESC',[wallet])).rows.map(receipt)};});
 route('get','/api/rounds',async()=>({rounds:(await db.query('SELECT * FROM rounds ORDER BY number DESC LIMIT 100')).rows.map(publicRound)}));
 route('get','/api/rounds/:id/proof',async(req,reply)=>{const row=(await db.query('SELECT * FROM rounds WHERE id=$1',[req.params.id])).rows[0];if(!row)return reply.code(404).send({error:'Round not found'});return{version:1,treasury:config.FEE_RECIPIENT,rules:RULES,round:{id:row.id,number:Number(row.number),...row.data}};});
 route('get','/api/admin',async req=>{await owner(req);return{settings:engine.settings,blockers:engine.blockers(),round:publicRound(await engine.active()),audit:(await db.query('SELECT * FROM audit ORDER BY id DESC LIMIT 100')).rows};});
 route('post','/api/admin/pause',async req=>{await owner(req);const {paused}=z.object({paused:z.boolean()}).parse(req.body);await engine.saveSettings({...engine.settings,paused});await audit(db,'automation.pause',{paused});return{ok:true};});
 route('post','/api/admin/funding',async req=>{await owner(req);const {signature}=z.object({signature:z.string().min(64).max(100)}).parse(req.body);await engine.seed(signature);await engine.refresh();return{ok:true};});
 route('post','/api/admin/packs',async req=>{await owner(req);const {code}=z.object({code:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)}).parse(req.body);const catalog=await providers.machines(),pack=catalog.find((p:any)=>p.code===code);if(!pack)throw new Error('Exact machine, inventory, or access could not be verified');if(![250,500,2000].includes(pack.price))throw new Error('This release supports $250, $500, and $2,000 tiers only.');await engine.saveSettings({...engine.settings,enabledPacks:[...new Set([...engine.settings.enabledPacks,code])]});engine.catalog=catalog;await audit(db,'pack.enabled',{code,price:pack.price});return{ok:true};});
 route('post','/api/admin/classify',async req=>{await owner(req);const b=z.object({roundId:z.string().uuid(),kind:z.enum(['watch','pokemon'])}).parse(req.body),row=await engine.active();if(!row||row.id!==b.roundId||row.data.state!=='review'||row.data.kind!=='unknown'||!row.data.prize)throw new Error('No unclassified prize awaiting review');row.data.kind=b.kind;row.data.prize.kind=b.kind;row.data.state=b.kind==='watch'?'transferring':'selling';delete row.data.error;await engine.save(row.id,row.data);await audit(db,'asset.classified',{roundId:row.id,kind:b.kind});return{ok:true};});
 route('post','/api/admin/retry',async req=>{await owner(req);const b=z.object({roundId:z.string().uuid()}).parse(req.body),row=await engine.active();if(!row||row.id!==b.roundId)throw new Error('Pending round not found');if(row.data.kind==='unknown')throw new Error('Classify the prize before resuming');
   // Restore only the last persisted stage. Identity, snapshot, beacon and winner are immutable.
   if(row.data.state==='review'){if(!row.data.winner)throw new Error('Commitment failures require on-chain reconciliation, not a new draw');row.data.state=row.data.saleMicros?'paying':row.data.prize?(row.data.kind==='watch'?'transferring':'selling'):'purchasing';await engine.save(row.id,row.data);}await audit(db,'round.retry',{roundId:row.id});return{ok:true};});
 app.setErrorHandler((error,req,reply)=>{const e=error as Error&{statusCode?:number};reply.code(e.statusCode??(error instanceof z.ZodError?400:503)).send({error:error instanceof z.ZodError?'Invalid request fields':e.message});});
 if(config.SERVE_STATIC==='true'&&existsSync(resolve('dist/index.html'))){await app.register(staticPlugin,{root:resolve('dist')});app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({error:'Not found'}):reply.sendFile('index.html'));}
 let timer:ReturnType<typeof setInterval>|undefined;
 if(options.timers!==false){serial.run(()=>engine.tick()).catch(()=>{});timer=setInterval(()=>{serial.run(()=>engine.tick()).catch(()=>{});},5000);}
 app.addHook('onClose',async()=>{if(timer)clearInterval(timer);await serial.run(()=>db.close());});
 return{app,engine,db,serial};
}
function packViews(engine:Engine){return[{code:'ewatch_250',name:'The Original',price:250},{code:'ewatch_500',name:'The Signature',price:500},{code:'epokewatch_2000',name:'Pokewatch 2000',price:2000}].map(p=>{const live=engine.catalog.find(x=>x.code===p.code),locked=!engine.settings.enabledPacks.includes(p.code);return{...p,locked,available:!!live&&!locked,odds:live?.odds??null,watchOdds:null,image:live?.imageNobg??null};});}
