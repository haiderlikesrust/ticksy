import { randomUUID } from 'node:crypto';
import { PublicKey, SystemProgram, ComputeBudgetProgram, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { createRequire } from 'node:module';
const { OnlinePumpSdk, PUMP_SDK, feeSharingConfigPda, normalizeQuoteMint } = createRequire(import.meta.url)('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
import { Chain, type TxPolicy } from './chain';
import { Jobs, PendingOperation, ReviewRequired } from './jobs';
import { config } from './config';
import { PACK_TIERS } from '../shared/game';
import type { Prize, Settings, BuybackQuote } from '../shared/types';
import { fetchMetadata } from './remote-metadata';
import { recordIncome } from './accounting';
import { classifyAsset } from './settlement';

export async function jsonFetch(url:string,init:RequestInit={}){const response=await fetch(url,{...init,signal:AbortSignal.timeout(15_000)});const body:any=await response.json();if(!response.ok)throw new Error(body.error||body.message||`Provider returned HTTP ${response.status}`);return body;}
const CC='https://gacha.collectorcrypt.com';
const JUP='https://api.jup.ag/swap/v2';
const PACK_WALLET=config.COLLECTOR_CRYPT_PAYMENT_WALLET;
export class Providers {
  private buybackCache=new Map<string,{expires:number;quote:Promise<BuybackQuote>}>();
  constructor(readonly chain:Chain,readonly jobs:Jobs){}
  buybackQuote(mint:string):Promise<BuybackQuote>{
    const cached=this.buybackCache.get(mint);if(cached&&cached.expires>Date.now())return cached.quote;
    if(this.buybackCache.size>=128)this.buybackCache.delete(this.buybackCache.keys().next().value!);
    const quote=(async():Promise<BuybackQuote>=>{try{
      const result=await this.cc(`/buyback/available?nft=${encodeURIComponent(mint)}`);
      if(result.available===false)return{status:'unavailable',amount:null,checkedAt:Date.now()};
      const amount=Number(result.amount);
      if(result.available!==true||!Number.isSafeInteger(amount)||amount<10_000||amount>280_000_000_000)throw new Error('Invalid buyback quote');
      return{status:'available',amount:amount/1e6,checkedAt:Date.now()};
    }catch{return{status:'error',amount:null,checkedAt:Date.now()};}})();
    this.buybackCache.set(mint,{expires:Date.now()+60_000,quote});return quote;
  }
  cc(path:string,data?:unknown){return jsonFetch(`${CC}/api${path}`,{method:data?'POST':'GET',headers:{...(data?{'Content-Type':'application/json'}:{}),...(config.COLLECTOR_CRYPT_API_KEY?{'x-api-key':config.COLLECTOR_CRYPT_API_KEY}:{})},body:data?JSON.stringify(data):undefined});}
  async machines(){const[catalog,status]=await Promise.all([this.cc('/machines'),this.cc('/status')]);if(status.machineStatus!=='running')return[];let privateMachines:any[]=[];if(config.COLLECTOR_CRYPT_API_KEY){try{const partner=await this.cc('/v1/machines');privateMachines=partner.machines??[];}catch{/* Public packs remain available. Private tiers stay locked. */}}
    return catalog.machines.filter((m:any)=>(m.public||privateMachines.some(p=>p.code===m.code&&p.sells===true))&&/watch/i.test(m.code)&&Number.isInteger(m.price)&&m.price>0&&m.price<=10000&&m.contains===1&&Object.values(m.stock??{}).length>0&&Object.values(m.stock??{}).every((n:any)=>Number.isFinite(n)&&n>0)&&status.gachas?.some((s:any)=>s.code===m.code&&s.isOpen));}
  quote(inputMint:string,outputMint:string,amount:bigint,taker?:string,slippageBps=100){return jsonFetch(`${JUP}/order?${new URLSearchParams({inputMint,outputMint,amount:amount.toString(),slippageBps:String(slippageBps),excludeRouters:'jupiterz,dflow,okx',...(taker?{taker}:{})})}`,{headers:{'x-api-key':config.JUPITER_API_KEY}});}
  async tokenDelta(signature:string,mint:string){const{rpc,signer}=this.chain.require();const tx=await rpc.getTransaction(signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});if(!tx||!tx.meta)throw new PendingOperation('Waiting for transaction accounting.');if(tx.meta.err)throw new ReviewRequired('Transaction failed.');
    if(mint===NATIVE_MINT.toBase58()){const index=tx.transaction.message.staticAccountKeys.findIndex(k=>k.equals(signer.publicKey));if(index<0)return 0n;return BigInt(tx.meta.postBalances[index]-tx.meta.preBalances[index]+(index===0?tx.meta.fee:0));}
    const sum=(rows:any[]):bigint=>rows.filter(a=>a.owner===this.chain.address&&a.mint===mint).reduce<bigint>((s,a)=>s+BigInt(a.uiTokenAmount.amount),0n);return sum(tx.meta.postTokenBalances??[])-sum(tx.meta.preTokenBalances??[]);
  }
  async swap(id:string,inputMint:string,outputMint:string,amount:bigint,settings:Settings,minOutput=1n){
    if(amount<=0n)throw new Error('Swap amount must be positive.');
    let job=await this.jobs.get(id);if(!job)await this.jobs.put(id,'swap','queued',{inputMint,outputMint,amount:amount.toString(),minOutput:minOutput.toString()});
    job=await this.jobs.get(id);const d=job.data;
    if(d.inputMint!==inputMint||d.outputMint!==outputMint||d.amount!==amount.toString())throw new ReviewRequired('Swap intent changed during recovery.');
    const policy:TxPolicy={kind:'swap',inputMint,maxInput:amount,outputMint,minOutput};
    const signature=await this.chain.execute(id,'swap',async()=>{const requestedAt=Date.now(),order=await this.quote(inputMint,outputMint,amount,this.chain.address!,settings.slippageBps);if(Date.now()-requestedAt>10_000)throw new Error('Swap quote is stale. Retry with current pricing.');if(order.errorCode||!order.transaction)throw new Error(order.errorMessage||'No supported swap route.');if(order.router!=='metis'||order.inputMint!==inputMint||order.outputMint!==outputMint||BigInt(order.inAmount)!==amount)throw new ReviewRequired('Swap quote route, asset or amount mismatch.');const guaranteed=BigInt(order.outAmount)*(10_000n-BigInt(settings.slippageBps))/10_000n;if(guaranteed<minOutput)throw new Error('Swap no longer funds the selected pack.');if(BigInt(order.otherAmountThreshold??'0')<guaranteed||Number(order.slippageBps)>settings.slippageBps)throw new ReviewRequired('Swap exceeds the configured slippage ceiling.');policy.minOutput=guaranteed;const tx=VersionedTransaction.deserialize(Buffer.from(order.transaction,'base64'));if(tx.message.header.numRequiredSignatures!==1)throw new ReviewRequired('Swap requires an unsupported co-signer.');return tx;},settings,policy);
    const received=await this.tokenDelta(signature,outputMint);if(received<minOutput)throw new ReviewRequired('Settled swap output is insufficient.');return {signature,received};
  }
  async collectFees(settings:Settings){
    const{rpc,signer}=this.chain.require();if(config.FEE_RECIPIENT!==this.chain.address)throw new Error('The treasury signer must be the dedicated fee recipient.');
    const unfinished=(await this.jobs.db.query("SELECT * FROM jobs WHERE kind='fee-cycle' AND status<>'complete' ORDER BY created_at LIMIT 1")).rows[0];
    let cycle=unfinished;
    if(!cycle){
      const mint=new PublicKey(config.MEMECOIN_MINT),sdk=new OnlinePumpSdk(rpc),curve=await sdk.fetchBondingCurve(mint);if(curve.isHolderReward)throw new Error('This mint routes fees to holder rewards, not its creator.');
      const quote=normalizeQuoteMint(curve.quoteMint),sharing=curve.creator.equals(feeSharingConfigPda(mint));
      if(quote.toBase58()!==config.CARDS_MINT)throw new ReviewRequired('The configured club coin must be paired with CARDS');
      if(!sharing&&!curve.creator.equals(signer.publicKey))throw new Error('Configured wallet is not the mint’s creator-fee recipient.');
      if(sharing){const info=await rpc.getAccountInfo(curve.creator);if(!info)throw new Error('Fee sharing account is missing.');const shared=PUMP_SDK.decodeSharingConfig(info);if(!shared.shareholders.some(s=>s.address.equals(signer.publicKey)))throw new Error('Treasury is not a shareholder of this mint.');}
      const balances=await sdk.getCreatorVaultQuoteBalances(curve.creator),balance=balances.find(b=>b.mint.equals(quote));if(!balance||balance.total.isZero())return;
      const id=`fees:${randomUUID()}`;await this.jobs.put(id,'fee-cycle','claiming',{quoteMint:quote.toBase58(),creator:curve.creator.toBase58(),sharing,graduated:curve.complete});cycle=await this.jobs.get(id);
    }
    const d=cycle.data,quoteMint=new PublicKey(d.quoteMint),mint=new PublicKey(config.MEMECOIN_MINT),sdk=new OnlinePumpSdk(rpc);
    if(!d.claimSignature){d.claimSignature=await this.chain.execute(`${cycle.id}:claim`,'fee-claim',async()=>{const quoteTokenProgram=await sdk.fetchQuoteTokenProgram(quoteMint);const ixs=[ComputeBudgetProgram.setComputeUnitLimit({units:350_000})];if(d.sharing){const address=new PublicKey(d.creator),info=await rpc.getAccountInfo(address);if(!info)throw new Error('Sharing configuration is missing.');const shared=PUMP_SDK.decodeSharingConfig(info);if(d.graduated)ixs.push(await PUMP_SDK.transferCreatorFeesToPumpV2({payer:signer.publicKey,mint,quoteMint,quoteTokenProgram}));ixs.push(await PUMP_SDK.distributeCreatorFeesV2({mint,sharingConfig:shared,sharingConfigAddress:address,quoteMint,quoteTokenProgram,payer:signer.publicKey,shouldInitializeAta:true}));}else{if(!quoteMint.equals(NATIVE_MINT))ixs.push(createAssociatedTokenAccountIdempotentInstruction(signer.publicKey,getAssociatedTokenAddressSync(quoteMint,signer.publicKey,false,quoteTokenProgram),signer.publicKey,quoteMint,quoteTokenProgram));ixs.push(...await sdk.collectCoinCreatorFeeV2Instructions(signer.publicKey,quoteMint,quoteTokenProgram,signer.publicKey));}return this.chain.build(ixs);},settings);await this.jobs.put(cycle.id,'fee-cycle','routing',d);}
    if(!d.amount){const delta=await this.tokenDelta(d.claimSignature,d.quoteMint);d.amount=(delta>0n?delta:0n).toString();await this.jobs.put(cycle.id,'fee-cycle','routing',d);}
    if(BigInt(d.amount)===0n){await this.jobs.put(cycle.id,'fee-cycle','complete',d);return;}
    if(!d.cardsAmount){d.cardsAmount=d.quoteMint===config.CARDS_MINT?d.amount:(await this.swap(`${cycle.id}:cards`,d.quoteMint,config.CARDS_MINT,BigInt(d.amount),settings)).received.toString();await this.jobs.put(cycle.id,'fee-cycle','accounting',d);}
    if(!d.usdcSignature){const settled=await this.swap(`${cycle.id}:usdc`,config.CARDS_MINT,config.USDC_MINT,BigInt(d.cardsAmount),settings);d.usdcSignature=settled.signature;d.usdcAmount=settled.received.toString();await this.jobs.put(cycle.id,'fee-cycle','accounting',d);}
    await this.finalized(d.usdcSignature);
    await recordIncome(this.jobs.db,cycle.id,'fee',BigInt(d.usdcAmount),d.usdcSignature);
    await this.jobs.put(cycle.id,'fee-cycle','complete',d);
  }
  async finalized(signature:string){const {rpc}=this.chain.require();const state=(await rpc.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];if(!state||state.confirmationStatus!=='finalized')throw new PendingOperation('Waiting for final settlement');if(state.err)throw new ReviewRequired('Finalized transaction failed');}
  async purchase(roundId:string,code:string,price:bigint,settings:Settings):Promise<Prize>{
    const id=`pack:${roundId}`;let job=await this.jobs.get(id);if(job?.status==='complete')return job.data.prize;
    if(!job){const pack=(await this.machines()).find((p:any)=>p.code===code&&BigInt(p.price)*1_000_000n===price);if(!pack)throw new PendingOperation('Committed pack is unavailable; the same winner and pack remain reserved');await this.jobs.put(id,'pack','purchasing',{code,price:price.toString()});job=await this.jobs.get(id);}
    const d=job.data;if(d.code!==code||d.price!==price.toString())throw new ReviewRequired('Committed pack intent changed');
    const reservation=(await this.jobs.db.query("SELECT * FROM reservations WHERE round_id=$1 AND status<>'released'",[roundId])).rows[0];if(!reservation||BigInt(reservation.amount_micros)!==price)throw new ReviewRequired('Pack has no matching durable reservation');
    if(!d.memo){const order=await this.cc('/generatePack',{playerAddress:this.chain.address,packType:code,turbo:false});if(!order.memo||!order.transaction)throw new Error('Invalid purchase response');d.memo=order.memo;d.transaction=order.transaction;await this.jobs.put(id,'pack','purchasing',d);}
    if(!d.paymentSignature){const policy:TxPolicy={kind:'pack',inputMint:config.USDC_MINT,minInput:price,maxInput:price,recipient:PACK_WALLET,memo:d.memo};
      d.paymentSignature=await this.chain.execute(`${id}:payment`,'pack-payment',async()=>{const tx=await this.packPayment(id,d);policy.memo=d.memo;return tx;},settings,policy);await this.jobs.put(id,'pack','opening',d);}
    await this.finalized(d.paymentSignature);
    await this.jobs.db.query("INSERT INTO ledger(id,kind,amount_micros,signature,created_at) VALUES($1,'pack',$2,$3,$4) ON CONFLICT DO NOTHING",[id,price.toString(),d.paymentSignature,Date.now()]);
    await this.jobs.db.query("UPDATE reservations SET status='spent' WHERE round_id=$1",[roundId]);
    const status=await this.cc(`/pack/status?memo=${encodeURIComponent(d.memo)}`);if(status.pack?.refunded)throw new ReviewRequired('Provider reports a refund; retain the winner and reconcile the refund before further actions');
    if(!d.opened){const result=await this.cc('/openPack',{memo:d.memo});if(result.code==='TURBO_MODE_BUYBACK')throw new ReviewRequired('Unexpected provider auto-sale; reconcile actual proceeds');if(!result.nft_address)throw new PendingOperation('Waiting for the provider to finish this same pack');d.opened=result;d.awardedAt=Date.now();await this.jobs.put(id,'pack','verifying',d);}
    if(!await this.chain.ownsNft(d.opened.nft_address))throw new PendingOperation('Waiting for the prize to reach the treasury');
    const card=d.opened.nftWon,meta=card?.content?.metadata??card?.metadata??{};
    const image=card?.content?.links?.image??card?.content?.files?.[0]?.uri??meta.image??card?.image;
    const insured=Number(status.send?.insured_value??meta.attributes?.find((a:any)=>/insured.?value/i.test(a.trait_type))?.value??0);
    const issued=Date.parse(status.send?.created_at??'');const awardedAt=Number.isFinite(issued)?issued:d.awardedAt;
    const prize:Prize={id,coinMint:config.MEMECOIN_MINT,mint:d.opened.nft_address,name:meta.name??card?.name??'Collectible',image:typeof image==='string'&&image.startsWith('https://')?image:'',value:Number.isFinite(insured)?insured:0,rarity:d.opened.rarity??'Unrated',purchaseSignature:d.paymentSignature,kind:classifyAsset(meta),awardedAt,buybackExpiresAt:awardedAt+72*3_600_000};
    d.prize=prize;await this.jobs.db.query("INSERT INTO prizes(id,mint,data,status) VALUES($1,$2,$3,'available') ON CONFLICT(id) DO NOTHING",[id,prize.mint,JSON.stringify(prize)]);await this.jobs.put(id,'pack','complete',d);return prize;
  }
  async packPayment(id:string,d:any){
    const payment=await this.jobs.get(`${id}:payment`);if(payment?.data.raw||payment?.data.signature)throw new ReviewRequired('Reconcile existing payment before refreshing');
    const tx=VersionedTransaction.deserialize(Buffer.from(d.transaction,'base64'));const {rpc}=this.chain.require();
    if((await rpc.isBlockhashValid(tx.message.recentBlockhash,{commitment:'confirmed'})).value)return tx;
    const status=await this.cc(`/pack/status?memo=${encodeURIComponent(d.memo)}`);
    if(!status||!('pack'in status)||!('send'in status))throw new PendingOperation('Cannot verify previous pack status');
    if(status.pack&&(status.pack.status!==null||status.pack.transaction_signature||status.pack.webhook_received||status.pack.refunded)||status.send)throw new ReviewRequired('Existing pack has provider activity');
    const order=await this.cc('/generatePack',{playerAddress:this.chain.address,packType:d.code,turbo:false});if(!order.memo||!order.transaction)throw new Error('Invalid replacement order');d.previousMemos=[...(d.previousMemos??[]),d.memo];d.memo=order.memo;d.transaction=order.transaction;await this.jobs.put(id,'pack','purchasing',d);return VersionedTransaction.deserialize(Buffer.from(d.transaction,'base64'));
  }
}
