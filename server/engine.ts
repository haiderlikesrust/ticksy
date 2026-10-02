import { randomUUID } from 'node:crypto';
import { TransactionInstruction,PublicKey } from '@solana/web3.js';
import type { Database } from './db';
import { atomic,audit } from './db';
import { Chain } from './chain';
import { Jobs,PendingOperation,ReviewRequired } from './jobs';
import { Providers } from './providers';
import { config,configBlockers,defaultSettings } from './config';
import { accounting,recordIncome } from './accounting';
import { Beacon,captureSnapshot,chooseWinner,hash } from './draw';
import { RULES,RESERVE,canSpend,feeRate,intervalMs,selectPack,splitSale } from '../shared/policy';
import { sellCard,payUSDC } from './settlement';
import type { Settings,RoundData,Snapshot } from '../shared/types';

export class Engine {
 settings:Settings={...defaultSettings};lastEvaluation=0;lastClaim=0;error:string|null=null;
 view:any={balanceMicros:null,availableMicros:null,budgetMicros:null,rateMicros:null,reserveMicros:RESERVE.toString(),reason:'The treasury is preparing for its first verified opening.',nextEstimateAt:null};
 catalog:any[]=[];lastCatalog=0;
 constructor(readonly db:Database,readonly chain:Chain,readonly providers:Providers,readonly beacon=new Beacon()){}
 async init(){const row=(await this.db.query('SELECT data FROM settings WHERE id=1')).rows[0];if(row)this.settings=row.data;else await this.saveSettings(this.settings);await this.chain.init();}
 async saveSettings(settings:Settings){await this.db.query('INSERT INTO settings(id,data) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data',[JSON.stringify(settings)]);this.settings=settings;}
 blockers(){return[...configBlockers(),...(this.chain.address&&this.chain.address!==config.FEE_RECIPIENT?['The treasury must match the dedicated creator-fee recipient']:[])];}
 async active(){return(await this.db.query("SELECT * FROM rounds WHERE status NOT IN ('complete','cancelled') ORDER BY number LIMIT 1")).rows[0]??null;}
 async save(id:string,data:RoundData){await this.db.query('UPDATE rounds SET status=$2,data=$3 WHERE id=$1',[id,data.state,JSON.stringify(data)]);}
 async tick(now=Date.now()){
   this.error=null;
   try{
     const active=await this.active();
     if(active){if(config.live&&this.chain.address&&this.chain.connection)await this.advance(active,now);return;}
     if(now-this.lastEvaluation<60_000)return;this.lastEvaluation=now;
     await this.refresh(now);
     if(this.blockers().length||this.settings.paused)return;
     if(now-this.lastClaim>=30_000){this.lastClaim=now;await this.providers.collectFees(this.settings);await this.refresh(now);}
     await this.schedule(now);
   }catch(e){this.error=(e as Error).message;const row=await this.active();if(row){row.data.error=this.error;if(e instanceof ReviewRequired)row.data.state='review';await this.save(row.id,row.data);}else this.view.reason=this.error;}
 }
 async refresh(now=Date.now()){
   if(now-this.lastCatalog>60_000){try{this.catalog=await this.providers.machines();this.lastCatalog=now;}catch{this.catalog=[];}}
   const a=await accounting(this.db,now);this.view.budgetMicros=a.budget.toString();this.view.rateMicros=feeRate(a.last10m,a.last1h).toString();this.view.dayCommittedMicros=a.dayCommitted.toString();
   if(!this.chain.connection||!config.FEE_RECIPIENT){this.view.reason='Awaiting the club coin and treasury configuration.';return;}
   const mint=new PublicKey(config.USDC_MINT);const usdc=await this.chain.connection.getParsedTokenAccountsByOwner(new PublicKey(config.FEE_RECIPIENT),{mint},'finalized');
   const balance=usdc.value.reduce((sum,x)=>sum+BigInt(x.account.data.parsed.info.tokenAmount.amount),0n);
   const available=balance-a.reserved-a.obligations;
   this.view.balanceMicros=balance.toString();this.view.availableMicros=(available>0n?available:0n).toString();
   await this.db.query('INSERT INTO treasury_days(day,base_micros) VALUES($1,$2) ON CONFLICT DO NOTHING',[a.day,(available>0n?available:0n).toString()]);
   this.view.reason=this.blockers().length?'Launch configuration is being completed.':this.settings.paused?'New openings are paused.':'Accumulating fees for the next opening.';
   this.view.updatedAt=now;
 }
 async schedule(now=Date.now()){
   if(await this.active())return;
   const a=await accounting(this.db,now),available=BigInt(this.view.availableMicros??'0'),rate=feeRate(a.last10m,a.last1h);
   const base=(await this.db.query('SELECT base_micros FROM treasury_days WHERE day=$1',[a.day])).rows[0];if(!base||rate<=0n){this.view.nextEstimateAt=null;this.view.reason='Accumulating fees. No new opening is committed while recent income is zero.';return;}
   const gas=await this.chain.connection!.getBalance(new PublicKey(config.FEE_RECIPIENT),'finalized');if(gas<Math.ceil(this.settings.gasReserveSol*1e9)+20_000_000)throw new PendingOperation('Replenish the operating SOL reserve before opening');
   const count=Number((await this.db.query("SELECT COUNT(*)::int AS n FROM rounds WHERE status='complete'")).rows[0].n);
   const pack=selectPack(count,this.catalog.filter(p=>this.settings.enabledPacks.includes(p.code)),cost=>canSpend(cost,available,a.budget,BigInt(base.base_micros),a.dayIncome,a.dayCommitted),rate);
   if(!pack){this.view.reason='Accumulating fees. Budget, inventory, or treasury limits are not yet satisfied.';this.view.nextEstimateAt=null;return;}
   const price=BigInt(pack.price)*1_000_000n,interval=intervalMs(price,rate)!;
   const latest=(await this.db.query("SELECT created_at FROM rounds WHERE status<>'cancelled' ORDER BY created_at DESC LIMIT 1")).rows[0];
   const firstIncome=(await this.db.query("SELECT MIN(created_at)::text AS at FROM ledger WHERE kind='fee'")).rows[0];
   const anchor=latest?Number(latest.created_at):Number(firstIncome.at??now);
   const due=anchor+interval;this.view.nextEstimateAt=due;this.view.nextPackCode=pack.code;
   if(now<due){this.view.reason='Accumulating fees at a sustainable opening pace.';return;}
   const id=randomUUID(),data:RoundData={state:'snapshot',code:pack.code,priceMicros:price.toString(),opensAt:0};
   await atomic(this.db,async()=>{await this.db.query('INSERT INTO rounds(id,status,data,created_at) VALUES($1,$2,$3,$4)',[id,data.state,JSON.stringify(data),now]);await this.db.query("INSERT INTO reservations(round_id,amount_micros,day,status) VALUES($1,$2,$3,'reserved')",[id,price.toString(),a.day]);});
   await audit(this.db,'round.reserved',{id,code:pack.code,price:price.toString()});
 }
 async advance(row:any,now=Date.now()){
   const d:RoundData=row.data,id=row.id;if(d.state==='review')return;
   if(d.state==='snapshot'){
     const snapshot=await captureSnapshot(this.chain);
     if(!snapshot.holders.length){d.state='cancelled';d.error='No eligible holders at the finalized snapshot';await atomic(this.db,async()=>{await this.save(id,d);await this.db.query("UPDATE reservations SET status='released' WHERE round_id=$1",[id]);});return;}
     const future=await this.beacon.future(now+120_000);d.snapshot=snapshot;d.opensAt=future.time;d.commitment={version:1,roundId:id,snapshotHash:hash(snapshot),rulesHash:hash(RULES),pack:{code:d.code,priceMicros:d.priceMicros},beaconRound:future.round,opensAt:d.opensAt};d.commitmentHash=hash(d.commitment);d.state='committing';await this.save(id,d);
   }
   if(d.state==='committing'){
     const txJob=await this.providers.jobs.get(`commit:${id}`);
     // A missed commitment is held visibly; never choose a different beacon after seeing it.
     if(now>=d.opensAt&&!txJob?.data.signature)throw new ReviewRequired('Commitment deadline missed. No draw or purchase occurred; manual cancellation only.');
     const payload=`ticksy:v1:${id}:${d.commitmentHash}:${d.commitment!.beaconRound}`;
     d.commitSignature=await this.chain.execute(`commit:${id}`,'draw-commitment',()=>this.chain.build([new TransactionInstruction({programId:new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),keys:[],data:Buffer.from(payload)})]),this.settings);
     await this.providers.finalized(d.commitSignature);
     const tx=await this.chain.connection!.getTransaction(d.commitSignature,{commitment:'finalized',maxSupportedTransactionVersion:0});
     if(!tx?.blockTime||tx.blockTime*1000>=d.opensAt)throw new ReviewRequired('Commitment did not land before the beacon deadline');
     d.state='committed';delete d.error;await this.save(id,d);await audit(this.db,'draw.committed',{id,hash:d.commitmentHash,signature:d.commitSignature});return;
   }
   if(d.state==='committed'){
     if(now<d.opensAt)return;d.beacon=await this.beacon.get(d.commitment!.beaconRound);d.winner=chooseWinner(d.snapshot!.holders,d.beacon.randomness,d.commitmentHash!);d.state='purchasing';await this.save(id,d);await audit(this.db,'draw.selected',{id,winner:d.winner});
   }
   if(d.state==='purchasing'){
     d.prize=await this.providers.purchase(id,d.code,BigInt(d.priceMicros),this.settings);d.kind=d.prize.kind;d.state=d.kind==='unknown'?'review':d.kind==='watch'?'transferring':'selling';if(d.state==='review')d.error='Verify the provider asset category before settlement';else delete d.error;await this.save(id,d);
   }
   if(d.state==='selling'){
     const sale=await sellCard(this.providers,id,d.prize!,this.settings);
     if(!sale){d.state='fallback';await this.save(id,d);}else{d.saleMicros=sale.amount.toString();d.saleSignature=sale.signature;d.state='paying';await this.save(id,d);await this.db.query("INSERT INTO ledger(id,kind,amount_micros,signature,created_at) VALUES($1,'buyback',$2,$3,$4) ON CONFLICT DO NOTHING",[`sale:${id}`,d.saleMicros,sale.signature,Date.now()]);}
   }
   if(d.state==='paying'){
     const split=splitSale(BigInt(d.saleMicros!));d.payoutSignature=await payUSDC(this.providers,`payout:${id}`,d.winner!,split.winner,this.settings);await this.save(id,d);
     await this.complete(id,d,'usdc',d.payoutSignature,split.winner);return;
   }
   if(d.state==='transferring'||d.state==='fallback'){
     d.transferSignature=await this.chain.transferNft(`transfer:${id}`,d.prize!.mint,d.winner!,this.settings);await this.providers.finalized(d.transferSignature);
     if(!await this.chain.ownsNft(d.prize!.mint,d.winner!))throw new PendingOperation('Waiting for recipient ownership to reconcile');
     await this.complete(id,d,d.kind==='watch'?'watch':'pokemon',d.transferSignature,0n);
   }
 }
 async complete(id:string,d:RoundData,kind:string,signature:string,amount:bigint){
   d.state='complete';d.completedAt=Date.now();delete d.error;
   await atomic(this.db,async()=>{
     await this.db.query('INSERT INTO payouts(id,round_id,winner,kind,amount_micros,mint,signature,data,created_at) VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',[id,d.winner,kind,amount.toString(),d.prize!.mint,signature,JSON.stringify({name:d.prize!.name,image:d.prize!.image,estimatedValue:d.prize!.value}),d.completedAt]);
     if(d.saleMicros)await this.db.query("INSERT INTO ledger(id,kind,amount_micros,created_at) VALUES($1,'treasury-return',$2,$3) ON CONFLICT DO NOTHING",[`return:${id}`,splitSale(BigInt(d.saleMicros)).treasury.toString(),d.completedAt]);
     await this.save(id,d);await this.db.query("UPDATE prizes SET status='delivered',winner=$2,round_id=$3,transfer_signature=$4 WHERE id=$1",[`pack:${id}`,d.winner,id,signature]);await audit(this.db,'reward.settled',{id,kind,winner:d.winner,signature});
   });
   this.lastEvaluation=0;
 }
 async seed(signature:string){
   if(!this.chain.connection||!config.FEE_RECIPIENT)throw new Error('Configure the treasury RPC first');
   const tx=await this.chain.connection.getParsedTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!tx||tx.meta?.err||!tx.meta)throw new Error('Deposit is not finalized');
   const sum=(xs:any[]):bigint=>xs.filter(x=>x.owner===config.FEE_RECIPIENT&&x.mint===config.USDC_MINT).reduce<bigint>((s,x)=>s+BigInt(x.uiTokenAmount.amount),0n);
   const net=sum(tx.meta.postTokenBalances??[])-sum(tx.meta.preTokenBalances??[]);if(net<=0n)throw new Error('No positive USDC deposit into this treasury');
   const ownJob=(await this.db.query("SELECT id FROM jobs WHERE data->>'signature'=$1 OR data->>'usdcSignature'=$1",[signature])).rows[0];if(ownJob)throw new Error('Protocol transactions cannot be counted as launch funding');
   // Only plain SPL transfers qualify: provider sales and swaps cannot be relabeled as seed.
   const instructions=[...tx.transaction.message.instructions,...(tx.meta.innerInstructions??[]).flatMap(x=>x.instructions)];
   if(instructions.some((i:any)=>!['spl-token','spl-associated-token-account','system','spl-memo','compute-budget'].includes(i.program??'')&&!['ComputeBudget111111111111111111111111111111','MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'].includes(i.programId?.toBase58())))throw new Error('Launch funding must be a direct USDC transfer');
   await recordIncome(this.db,`seed:${signature}`,'seed',net,signature);await audit(this.db,'treasury.seed',{signature,amount:net.toString()});
 }
}
