import { PublicKey, VersionedTransaction, TransactionMessage, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction,createTransferCheckedInstruction,getAssociatedTokenAddressSync,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { config } from './config';
import type { Providers } from './providers';
import type { Settings,Prize } from '../shared/types';
import { PendingOperation,ReviewRequired } from './jobs';
import nacl from 'tweetnacl';
import { MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';

export function classifyAsset(meta:any):'watch'|'pokemon'|'unknown'{
 const attrs=Array.isArray(meta?.attributes)?meta.attributes:[];
 // Classify explicit provider category/brand fields, never the pack name or rarity.
 const values=attrs.filter((a:any)=>/^(category|type|brand|collection|game|asset type)$/i.test(a.trait_type??'')).map((a:any)=>String(a.value).toLowerCase());
 const watch=values.some((s:string)=>/^(watch|watches|rolex|casio|g-shock|seiko|bulova|tissot|timepiece|luxury watches)$/.test(s));
 const pokemon=values.some((s:string)=>/^(pok[eé]mon|pokemon card|pokémon card|pokemon tcg)$/.test(s));
 return watch===pokemon?'unknown':watch?'watch':'pokemon';
}
export async function payUSDC(p:Providers,id:string,winner:string,amount:bigint,settings:Settings){
 if(amount<=0n)throw new ReviewRequired('Payout must be positive');const {signer}=p.chain.require(),mint=new PublicKey(config.USDC_MINT),owner=new PublicKey(winner);
 const destination=getAssociatedTokenAddressSync(mint,owner),source=getAssociatedTokenAddressSync(mint,signer.publicKey);
 const signature=await p.chain.execute(id,'usdc-payout',()=>p.chain.build([createAssociatedTokenAccountIdempotentInstruction(signer.publicKey,destination,owner,mint),createTransferCheckedInstruction(source,mint,destination,signer.publicKey,amount,6)]),settings);
 await p.finalized(signature);return signature;
}
export async function sellCard(p:Providers,roundId:string,prize:Prize,settings:Settings):Promise<{signature:string;amount:bigint}|null>{
 const id=`buyback:${roundId}`;let job=await p.jobs.get(id);
 if(job?.status==='settled')return{signature:job.data.signature,amount:BigInt(job.data.amount)};
 // Always reconcile an already signed sale before considering an expiry fallback.
 const txJob=await p.jobs.get(`${id}:tx`);
 if(txJob?.data.raw||txJob?.data.signature){
   try{await p.chain.execute(`${id}:tx`,'buyback',async()=>{throw new PendingOperation('Previous sale must reconcile before refreshing');},settings);}catch(e){
     const latest=await p.jobs.get(`${id}:tx`);if(latest?.status==='retryable'){await p.jobs.put(id,'buyback','quoting',{mint:prize.mint});}else throw e;
   }
 }
 const settledTx=await p.jobs.get(`${id}:tx`);
 if(settledTx?.status==='confirmed'){
   const signature=settledTx.data.signature;await p.finalized(signature);const amount=await p.tokenDelta(signature,config.USDC_MINT);
   if(amount<=0n||await p.chain.ownsNft(prize.mint))throw new ReviewRequired('Buyback asset/payment reconciliation failed');
   await p.jobs.put(id,'buyback','settled',{mint:prize.mint,signature,amount:amount.toString()});return{signature,amount};
 }
 if(Date.now()>=(prize.buybackExpiresAt??Infinity)){if(!await p.chain.ownsNft(prize.mint))throw new ReviewRequired('Fallback asset ownership is unresolved');return null;}
 const available=await p.cc(`/buyback/available?nft=${encodeURIComponent(prize.mint)}`);
 if(available.available!==true){if(Date.now()>=(prize.buybackExpiresAt??Infinity)){if(!await p.chain.ownsNft(prize.mint))throw new ReviewRequired('Cannot deliver fallback: asset ownership is unresolved');return null;}throw new PendingOperation('Waiting for a provider buyback offer');}
 const amount=BigInt(available.amount);if(amount<=0n)throw new ReviewRequired('Invalid buyback amount');
 const result=await p.cc('/buyback',{playerAddress:p.chain.address,nftAddress:prize.mint});if(!result.transaction)throw new PendingOperation('Buyback transaction not yet available');
 await p.jobs.put(id,'buyback','selling',{mint:prize.mint,minimum:amount.toString()});
 const tx=VersionedTransaction.deserialize(Buffer.from(result.transaction,'base64'));
 await validateSale(p,tx,prize,amount,settings);
 await p.chain.execute(`${id}:tx`,'buyback',async()=>tx,settings);
 throw new PendingOperation('Waiting for finalized buyback');
}
export async function validateSale(p:Providers,tx:VersionedTransaction,prize:Prize,minimum:bigint,settings:Settings){
 const {rpc,signer}=p.chain.require();const provider=new PublicKey(config.COLLECTOR_CRYPT_PAYMENT_WALLET);
 const signers=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures);
 if(!signers.some(k=>k.equals(signer.publicKey))||signers.some(k=>!k.equals(signer.publicKey)&&!k.equals(provider)))throw new ReviewRequired('Unexpected buyback signer');
 for(let i=0;i<signers.length;i++)if(!signers[i].equals(signer.publicKey)&&!nacl.sign.detached.verify(tx.message.serialize(),tx.signatures[i],signers[i].toBytes()))throw new ReviewRequired('Invalid buyback co-signature');
 const tables=await Promise.all(tx.message.addressTableLookups.map(async l=>{const t=await rpc.getAddressLookupTable(l.accountKey);if(!t.value)throw new ReviewRequired('Missing buyback lookup table');return t.value;}));
 const message=TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:tables});
 const programs=new Set([TOKEN_PROGRAM_ID.toBase58(),ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),SystemProgram.programId.toBase58(),ComputeBudgetProgram.programId.toBase58(),'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',MPL_CORE_PROGRAM_ID,'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr']);
 if(message.instructions.some(i=>!programs.has(i.programId.toBase58())))throw new ReviewRequired('Unknown buyback program; review required');
 const asset=await rpc.getAccountInfo(new PublicKey(prize.mint));if(!asset)throw new ReviewRequired('Prize account missing');
 const isCore=asset.owner.toBase58()===MPL_CORE_PROGRAM_ID;
 if(!isCore&&asset.owner.toBase58()!==TOKEN_PROGRAM_ID.toBase58())throw new PendingOperation('Unsupported buyback asset standard; NFT fallback remains reserved');
 let transfers=0;
 for(const ix of message.instructions){const program=ix.programId.toBase58();
   if(program===MPL_CORE_PROGRAM_ID){if(!isCore||ix.data[0]!==14||ix.keys[0]?.pubkey.toBase58()!==prize.mint||!ix.keys[3]?.pubkey.equals(signer.publicKey)||ix.keys[4]?.pubkey.equals(signer.publicKey))throw new ReviewRequired('Unexpected Core asset operation');transfers++;}
   if(program==='metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'){if(isCore||ix.data[0]!==49||ix.data[1]!==0||ix.data.readBigUInt64LE(2)!==1n||ix.keys[4]?.pubkey.toBase58()!==prize.mint||!ix.keys[1]?.pubkey.equals(signer.publicKey))throw new ReviewRequired('Unexpected metadata asset operation');transfers++;}
 }
 if(isCore&&transfers!==1||transfers>1)throw new ReviewRequired('Buyback must move only the selected asset');
 await p.chain.validateExternal(tx,{kind:'buyback',sponsor:provider.toBase58(),coreAsset:isCore?prize.mint:undefined,inputMint:prize.mint,maxInput:1n,minInput:1n,outputMint:config.USDC_MINT,minOutput:minimum,allowedPrograms:[...programs]},settings);
}
