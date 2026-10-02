import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { AccountLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { config } from './config';
import { eligible } from '../shared/game';
import type { Eligibility, Settings } from '../shared/types';
import { Jobs, PendingOperation, ReviewRequired } from './jobs';
import { MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { treasurySigner } from './treasury-signer';
import { validatePackPayment } from './pack-policy';
import { weight } from '../shared/policy';
export const CORE_PROGRAM=MPL_CORE_PROGRAM_ID;
export type TxPolicy={kind:'swap'|'pack'|'buyback'|'internal';inputMint?:string;maxInput?:bigint;minInput?:bigint;outputMint?:string;minOutput?:bigint;allowedPrograms?:string[];recipient?:string;memo?:string;sponsor?:string;coreAsset?:string};
export class Chain {
  readonly connection:Connection|null;
  signer:Keypair|null=null;
  rpc={ok:false,latency:null as number|null,checkedAt:null as number|null};
  constructor(readonly jobs:Jobs){this.connection=config.SOLANA_RPC_URL?new Connection(config.SOLANA_RPC_URL,{commitment:'confirmed',confirmTransactionInitialTimeout:20_000,disableRetryOnRateLimit:true,fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.any([...(init?.signal?[init.signal as AbortSignal]:[]),AbortSignal.timeout(8000)])})}):null;}
  async init(){this.signer=treasurySigner(config.TREASURY_PRIVATE_KEY);}
  get address(){return this.signer?.publicKey.toBase58()??null;}
  require(){if(!config.live||!this.connection||!this.signer)throw new Error('Mainnet signing is disabled or not configured.');return{rpc:this.connection,signer:this.signer};}
  async health(){if(!this.connection)return;const start=Date.now();try{await this.connection.getSlot('confirmed');this.rpc={ok:true,latency:Date.now()-start,checkedAt:Date.now()};}catch{this.rpc={ok:false,latency:null,checkedAt:Date.now()};}}
  async eligibility(wallet:string):Promise<Eligibility>{
    if(!this.connection||!config.MEMECOIN_MINT)return{eligible:false,balance:'0',required:'0',supply:'0',percent:'0',configured:false};
    const mint=new PublicKey(config.MEMECOIN_MINT);const [supply,accounts]=await Promise.all([this.connection.getTokenSupply(mint,'confirmed'),this.connection.getParsedTokenAccountsByOwner(new PublicKey(wallet),{mint},'confirmed')]);
    const amounts=accounts.value.map(a=>String(a.account.data.parsed.info.tokenAmount.amount));const balance=amounts.reduce((s,a)=>s+BigInt(a),0n);const total=BigInt(supply.value.amount);const decimals=supply.value.decimals;const display=(n:bigint)=>`${n/10n**BigInt(decimals)}.${(n%10n**BigInt(decimals)).toString().padStart(decimals,'0')}`;
    return{eligible:eligible(amounts,total.toString()),balance:display(balance),required:display((total+199n)/200n),supply:display(total),percent:total?String(Number(balance*1_000_000n/total)/10_000):'0',configured:true,weight:weight(balance,total)};
  }
  async balance(mint:string,owner=this.address!){if(!this.connection||!owner)return 0n;if(mint===NATIVE_MINT.toBase58())return BigInt(await this.connection.getBalance(new PublicKey(owner),'confirmed'));const accounts=await this.connection.getParsedTokenAccountsByOwner(new PublicKey(owner),{mint:new PublicKey(mint)},'confirmed');return accounts.value.reduce((sum,a)=>sum+BigInt(a.account.data.parsed.info.tokenAmount.amount),0n);}
  async build(instructions:TransactionInstruction[]){const{rpc,signer}=this.require();const block=await rpc.getLatestBlockhash('confirmed');return new VersionedTransaction(new TransactionMessage({payerKey:signer.publicKey,recentBlockhash:block.blockhash,instructions}).compileToV0Message());}
  async validateExternal(tx:VersionedTransaction,policy:TxPolicy,settings:Settings){
    const {rpc,signer}=this.require();
    if(policy.kind==='pack'){
      if(!policy.recipient||!policy.memo||policy.inputMint!==config.USDC_MINT||policy.minInput!==policy.maxInput)throw new ReviewRequired('Configure and verify the complete pack payment intent.');
      validatePackPayment(tx,signer.publicKey,new PublicKey(policy.recipient),new PublicKey(config.USDC_MINT),policy.maxInput!,policy.memo);
    }
    const lookups=await Promise.all(tx.message.addressTableLookups.map(async l=>{const table=await rpc.getAddressLookupTable(l.accountKey);if(!table.value)throw new Error('Missing transaction address table.');return table.value;}));
    const message=TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:lookups});
    if(policy.kind!=='pack'&&!message.payerKey.equals(signer.publicKey)&&!(policy.kind==='buyback'&&message.payerKey.toBase58()===policy.sponsor))throw new Error('Transaction fee payer does not match the treasury.');
    const programs=new Set(policy.allowedPrograms??[]);
    for(const ix of message.instructions){
      const program=ix.programId.toBase58();if(programs.size&&!programs.has(program))throw new ReviewRequired(`Unexpected transaction program ${program}`);
      if([TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].includes(program)&&![3,9,12,17].includes(ix.data[0]))throw new ReviewRequired('Unexpected token authority operation.');
    }
    // Simulate every existing treasury token account and both expected ATAs. This checks
    // actual post-balances, retained owners/delegates, gas reserve and unauthorized debits.
    const groups=await Promise.all([TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].map(programId=>rpc.getTokenAccountsByOwner(signer.publicKey,{programId})));
    const owned=groups.flatMap(g=>g.value);const addresses=[signer.publicKey,...owned.map(a=>a.pubkey)];
    for(const mint of [policy.inputMint,policy.outputMint].filter(Boolean) as string[]){if(mint===NATIVE_MINT.toBase58()||mint===policy.coreAsset)continue;const info=await rpc.getAccountInfo(new PublicKey(mint));if(!info)throw new Error('Token mint not found.');const ata=getAssociatedTokenAddressSync(new PublicKey(mint),signer.publicKey,false,info.owner);if(!addresses.some(a=>a.equals(ata)))addresses.push(ata);}
    const coreIndex=policy.coreAsset?addresses.length:-1;if(policy.coreAsset)addresses.push(new PublicKey(policy.coreAsset));
    if(addresses.length>90)throw new ReviewRequired('Use a dedicated treasury with fewer than 90 token accounts.');
    const before=await rpc.getMultipleAccountsInfo(addresses,'confirmed');
    const simulation=await rpc.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:true,accounts:{encoding:'base64',addresses:addresses.map(a=>a.toBase58())},commitment:'confirmed'});
    if(simulation.value.err)throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
    const after=simulation.value.accounts;if(!after||after.length!==addresses.length)throw new Error('Missing simulation account results.');
    const deltas=new Map<string,bigint>();
    for(let i=1;i<addresses.length;i++){
      if(i===coreIndex)continue;
      const old=before[i]?.data,newBytes=after[i]?.data?.[0]?Buffer.from(after[i]!.data[0],'base64'):null;
      const a=old&&old.length>=165?AccountLayout.decode(old):null,b=newBytes&&newBytes.length>=165?AccountLayout.decode(newBytes):null;
      if(a&&b&&!a.mint.equals(b.mint))throw new ReviewRequired('Treasury token mint changed.');
      if(before[i]&&after[i]&&before[i]!.owner.toBase58()!==after[i]!.owner)throw new ReviewRequired('Treasury token program changed.');
      if(b&&(!b.owner.equals(signer.publicKey)||b.delegateOption!==a?.delegateOption&&b.delegateOption!==0||b.closeAuthorityOption!==a?.closeAuthorityOption&&b.closeAuthorityOption!==0))throw new ReviewRequired('Treasury ownership or authority changed.');
      if(a&&b&&(a.delegateOption!==b.delegateOption||!a.delegate.equals(b.delegate)||a.closeAuthorityOption!==b.closeAuthorityOption||!a.closeAuthority.equals(b.closeAuthority)))throw new ReviewRequired('Treasury token authority changed.');
      const mint=(a?.mint??b?.mint)?.toBase58();if(mint)deltas.set(mint,(deltas.get(mint)??0n)+(b?.amount??0n)-(a?.amount??0n));
    }
    const solDelta=BigInt(after[0]?.lamports??0)-BigInt(before[0]?.lamports??0);const maxNative=policy.inputMint===NATIVE_MINT.toBase58()?(policy.maxInput??0n):0n;
    if(solDelta<-(maxNative+20_000_000n)||BigInt(after[0]?.lamports??0)<BigInt(Math.round(settings.gasReserveSol*1e9)))throw new ReviewRequired('Transaction exceeds gas allowance or treasury reserve.');
    for(const[mint,delta]of deltas){if(delta<0n&&(mint!==policy.inputMint||-delta>(policy.maxInput??0n)))throw new ReviewRequired('Unexpected treasury token debit.');}
    if(policy.inputMint&&policy.inputMint!==NATIVE_MINT.toBase58()&&!policy.coreAsset&&-(deltas.get(policy.inputMint)??0n)<(policy.minInput??0n))throw new ReviewRequired('Payment amount does not match the pack.');
    if(policy.outputMint&&(deltas.get(policy.outputMint)??0n)<(policy.minOutput??0n))throw new ReviewRequired('Swap output is below the minimum.');
    if(coreIndex>=0){
      const previous=before[coreIndex],next=after[coreIndex];if(!previous||!next||previous.owner.toBase58()!==CORE_PROGRAM||next.owner!==CORE_PROGRAM)throw new ReviewRequired('Core asset program changed');
      const {deserializeAssetV1}=await import('@metaplex-foundation/mpl-core');const {publicKey,lamports}=await import('@metaplex-foundation/umi');
      const decode=(bytes:Uint8Array)=>deserializeAssetV1({publicKey:publicKey(policy.coreAsset!),executable:false,owner:publicKey(CORE_PROGRAM),lamports:lamports(0),rentEpoch:0n,data:bytes});
      const a=decode(previous.data),b=decode(Buffer.from(next.data[0],'base64'));
      if(a.owner!==signer.publicKey.toBase58()||b.owner===a.owner||a.name!==b.name||a.uri!==b.uri||JSON.stringify(a.updateAuthority)!==JSON.stringify(b.updateAuthority))throw new ReviewRequired('Core asset transfer did not match sale intent');
    }
  }
  async execute(id:string,kind:string,build:()=>Promise<VersionedTransaction>,settings:Settings,policy:TxPolicy={kind:'internal'}){
    const{rpc,signer}=this.require();let job=await this.jobs.get(id);
    if(job?.status==='confirmed')return job.data.signature as string;
    if(job?.status==='failed'){
      if(!job.data.automaticRetry||!job.data.signature)throw new ReviewRequired(job.error||'Transaction needs review.');
      if(Date.now()-Number(job.updated_at)<30_000)throw new PendingOperation('Retrying the failed transaction after reconciliation.');
      await this.recover(id);job=await this.jobs.get(id);
      if(job.status==='confirmed')return job.data.signature as string;
      if(job.status!=='retryable')throw new PendingOperation('Waiting for the previous transaction to settle.');
    }
    if(!job?.data.raw){
      if(await rpc.getBalance(signer.publicKey,'confirmed')<Math.ceil(settings.gasReserveSol*1e9)+20_000_000)throw new PendingOperation('Replenish the protected SOL operating reserve');
      const tx=await build();if(policy.kind!=='internal')await this.validateExternal(tx,policy,settings);
      tx.sign([signer]);const signature=bs58.encode(tx.signatures[0]);const data={...(job?.data??{}),raw:Buffer.from(tx.serialize()).toString('base64'),signature,blockhash:tx.message.recentBlockhash};
      await this.jobs.put(id,kind,'prepared',data);job=await this.jobs.get(id);
    }
    const data=job.data;const status=(await rpc.getSignatureStatuses([data.signature],{searchTransactionHistory:true})).value[0];
    if(status?.err){if(!['confirmed','finalized'].includes(status.confirmationStatus??''))throw new PendingOperation('Waiting for the failed transaction to reach confirmation.');await this.jobs.put(id,kind,'failed',{...data,automaticRetry:true},JSON.stringify(status.err));throw new PendingOperation('Transaction failed on-chain; automatic recovery is scheduled.');}
    if(status?.confirmationStatus==='confirmed'||status?.confirmationStatus==='finalized'){await this.jobs.put(id,kind,'confirmed',data);return data.signature as string;}
    const valid=await rpc.isBlockhashValid(data.blockhash,{commitment:'confirmed'});
    if(!valid.value&&!status){const landed=await rpc.getTransaction(data.signature,{maxSupportedTransactionVersion:0,commitment:'confirmed'});if(landed?.meta&&!landed.meta.err){await this.jobs.put(id,kind,'confirmed',data);return data.signature as string;}if(landed&&!landed.meta)throw new PendingOperation('Waiting for complete transaction history.');await this.jobs.put(id,kind,'failed',{...data,automaticRetry:true},'Blockhash expired; chain history has no successful transaction.');throw new PendingOperation('Transaction expired; automatic recovery is scheduled.');}
    if(!status)await rpc.sendRawTransaction(Buffer.from(data.raw,'base64'),{skipPreflight:false,maxRetries:2});
    await this.jobs.put(id,kind,'submitted',data);throw new PendingOperation('Waiting for transaction confirmation.');
  }
  async recover(id:string){
    const job=await this.jobs.get(id);if(!job)throw new Error('Job not found.');
    if(job.data.signature){
      const{rpc}=this.require();const status=(await rpc.getSignatureStatuses([job.data.signature],{searchTransactionHistory:true})).value[0];
      if(status?.err&&!['confirmed','finalized'].includes(status.confirmationStatus??''))throw new PendingOperation('Waiting for the failed transaction to reach confirmation.');
      if(status&&!status.err){if(status.confirmationStatus==='confirmed'||status.confirmationStatus==='finalized')await this.jobs.put(id,job.kind,'confirmed',job.data);return;}
      if(!status&&(await rpc.isBlockhashValid(job.data.blockhash,{commitment:'confirmed'})).value)throw new PendingOperation('Transaction is still valid; reconciliation must finish first.');
      const landed=await rpc.getTransaction(job.data.signature,{maxSupportedTransactionVersion:0,commitment:'confirmed'});
      if(landed&&!landed.meta)throw new PendingOperation('Waiting for complete transaction history.');
      if(landed?.meta&&!landed.meta.err){await this.jobs.put(id,job.kind,'confirmed',job.data);return;}
    }
    await this.jobs.put(id,job.kind,'retryable',{attempts:[...(job.data.attempts??[]),{signature:job.data.signature,error:job.error}],...Object.fromEntries(Object.entries(job.data).filter(([key])=>!['raw','signature','blockhash','attempts','automaticRetry'].includes(key)))});
  }
  async ownsNft(mint:string,wallet=this.address!){const{rpc}=this.require();const account=await rpc.getAccountInfo(new PublicKey(mint));if(!account)return false;
    if(account.owner.toBase58()===CORE_PROGRAM){const{createUmi}=await import('@metaplex-foundation/umi-bundle-defaults');const{fetchAsset}=await import('@metaplex-foundation/mpl-core');const asset=await fetchAsset(createUmi(config.SOLANA_RPC_URL),mint);return asset.owner===wallet;}
    return(await this.balance(mint,wallet))===1n;
  }
  async transferNft(id:string,mint:string,winner:string,settings:Settings){
    return this.execute(id,'nft-transfer',async()=>{
      if(!await this.ownsNft(mint))throw new ReviewRequired('The prize is not owned by the treasury.');
      const{signer,rpc}=this.require();const{createUmi}=await import('@metaplex-foundation/umi-bundle-defaults');const{keypairIdentity,publicKey}=await import('@metaplex-foundation/umi');const umi=createUmi(config.SOLANA_RPC_URL);umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(signer.secretKey)));
      const info=await rpc.getAccountInfo(new PublicKey(mint));let builder;
      if(info?.owner.toBase58()===CORE_PROGRAM){const core=await import('@metaplex-foundation/mpl-core');umi.use(core.mplCore());const asset=await core.fetchAsset(umi,mint),collectionKey=core.collectionAddress(asset),collection=collectionKey?await core.fetchCollection(umi,collectionKey):undefined;builder=core.transfer(umi,{asset,collection,newOwner:publicKey(winner)});}
      else{const mpl=await import('@metaplex-foundation/mpl-token-metadata');umi.use(mpl.mplTokenMetadata());const asset=await mpl.fetchDigitalAsset(umi,publicKey(mint));const tokenStandard=asset.metadata.tokenStandard.__option==='Some'?asset.metadata.tokenStandard.value:mpl.TokenStandard.NonFungible;const rules=asset.metadata.programmableConfig.__option==='Some'&&asset.metadata.programmableConfig.value.ruleSet.__option==='Some'?asset.metadata.programmableConfig.value.ruleSet.value:undefined;builder=mpl.transferV1(umi,{mint:publicKey(mint),tokenOwner:umi.identity.publicKey,destinationOwner:publicKey(winner),tokenStandard,authorizationRules:rules,amount:1});}
      const instructions=builder.getInstructions().map(ix=>new TransactionInstruction({programId:new PublicKey(ix.programId),keys:ix.keys.map(k=>({pubkey:new PublicKey(k.pubkey),isSigner:k.isSigner,isWritable:k.isWritable})),data:Buffer.from(ix.data)}));
      return this.build([ComputeBudgetProgram.setComputeUnitLimit({units:350_000}),...instructions]);
    },settings);
  }
}
