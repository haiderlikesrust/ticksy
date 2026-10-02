import { createHash } from 'node:crypto';
import { PublicKey, AccountInfo } from '@solana/web3.js';
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { fetchBeacon, roundAt, roundTime, type ChainInfo, type ChainClient } from 'drand-client';
import type { Chain } from './chain';
import { config } from './config';
import type { Snapshot, DrawCommitment, Holder } from '../shared/types';
import { RULES, weight } from '../shared/policy';

export const QUICKNET='52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
export function canonical(value:any):string {if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';}
export const hash=(value:any)=>createHash('sha256').update(canonical(value)).digest('hex');
export function holdersFrom(accounts:Snapshot['accounts'],supply:bigint,excluded:string[]):Holder[]{
 const totals=new Map<string,bigint>(),seen=new Set<string>();let aggregate=0n;
 for(const a of accounts){if(seen.has(a.address))throw new Error('Duplicate token account in snapshot');seen.add(a.address);const amount=BigInt(a.amount);if(amount<0n)throw new Error('Negative holder balance');aggregate+=amount;totals.set(a.owner,(totals.get(a.owner)??0n)+amount);}
 if(aggregate!==supply)throw new Error('Incomplete snapshot: account balances do not equal mint supply');
 const excludedSet=new Set(excluded);
 return [...totals].filter(([owner])=>!excludedSet.has(owner)&&PublicKey.isOnCurve(new PublicKey(owner).toBytes())).map(([wallet,balance])=>({wallet,balance:balance.toString(),weight:weight(balance,supply)})).filter(h=>h.weight>0).sort((a,b)=>a.wallet<b.wallet?-1:a.wallet>b.wallet?1:0);
}
export async function captureSnapshot(chain:Chain):Promise<Snapshot>{
 if(!chain.connection)throw new Error('Configure snapshot RPC');const rpc=chain.connection,mint=new PublicKey(config.MEMECOIN_MINT);
 // Strict same-bank comparison. Never merge pages or balances from different slots.
 for(let attempt=0;attempt<4;attempt++){
  const mintState=await rpc.getAccountInfoAndContext(mint,{commitment:'finalized'});
  if(!mintState.value||!mintState.value.owner.equals(TOKEN_PROGRAM_ID))throw new Error('Snapshot requires a standard SPL mint; unsupported token programs must be reviewed');
  const supply=MintLayout.decode(mintState.value.data).supply;
  const result=await rpc.getProgramAccounts(TOKEN_PROGRAM_ID,{commitment:'finalized',withContext:true,filters:[{dataSize:165},{memcmp:{offset:0,bytes:mint.toBase58()}}],minContextSlot:mintState.context.slot});
  if(result.context.slot!==mintState.context.slot)continue;
  const accounts=result.value.map(a=>{const token=AccountLayout.decode(a.account.data);if(!token.mint.equals(mint))throw new Error('RPC returned another mint');return{address:a.pubkey.toBase58(),owner:token.owner.toBase58(),amount:token.amount.toString()};}).sort((a,b)=>a.address<b.address?-1:1);
  const excluded=[...new Set([config.OWNER_WALLET,config.FEE_RECIPIENT,'11111111111111111111111111111111','1nc1nerator11111111111111111111111111111111111',...config.EXCLUDED_WALLETS.split(',')].map(x=>x.trim()).filter(Boolean))].sort();
  return{version:1,mint:mint.toBase58(),slot:result.context.slot,supply:supply.toString(),accounts,excluded,holders:holdersFrom(accounts,supply,excluded),createdAt:Date.now()};
 }
 throw new Error('RPC could not provide a complete same-slot finalized snapshot; retrying without selecting a winner');
}
export function chooseWinner(holders:Holder[],randomness:string,commitmentHash:string):string{
 if(!/^[a-f0-9]{64}$/i.test(randomness)||!/^[a-f0-9]{64}$/i.test(commitmentHash))throw new Error('Invalid random input');
 if(!holders.length||holders.some(h=>!Number.isInteger(h.weight)||h.weight<=0))throw new Error('No valid eligible weights');
 const total=holders.reduce((s,h)=>s+BigInt(h.weight),0n),space=1n<<256n,limit=space-space%total;
 for(let counter=0;;counter++){
  const digest=createHash('sha256').update(`ticksy-draw-v1:${commitmentHash}:${randomness}:${counter}`).digest('hex');const value=BigInt('0x'+digest);if(value>=limit)continue;
  let ticket=value%total;for(const h of holders){if(ticket<BigInt(h.weight))return h.wallet;ticket-=BigInt(h.weight);}
 }
}
export class Beacon {
 private infoValue:ChainInfo|null=null;
 private client:ChainClient|null=null;
 async info(){if(this.infoValue)return this.infoValue;const response=await fetch(`https://api.drand.sh/${QUICKNET}/info`,{signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('Randomness network unavailable');const info=await response.json() as ChainInfo;
 // Pin both the hash and quicknet public key, not the relay's self-reported identity.
 if(info.hash!==QUICKNET||info.public_key!==QUICKNET_KEY||info.period!==3||info.genesis_time!==1692803367)throw new Error('Unexpected randomness network');
 const options={disableBeaconVerification:false,noCache:false,chainVerificationParams:{chainHash:QUICKNET,publicKey:QUICKNET_KEY}};
 const baseUrl=`https://api.drand.sh/${QUICKNET}`;const read=async(path:string)=>{const r=await fetch(`${baseUrl}/${path}`,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('Randomness relay unavailable');return r.json();};
 this.client={options,get:round=>read(`public/${round}`),latest:()=>read('public/latest'),chain:()=>({baseUrl,info:async()=>info})};this.infoValue=info;return info;}
 async future(at:number){const info=await this.info();const round=roundAt(at,info)+1;return{round,time:roundTime(info,round)};}
 async get(round:number){await this.info();return fetchBeacon(this.client!,round);}
}
export const QUICKNET_KEY='83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a';
export function verifyDrawMath(snapshot:Snapshot,commitment:DrawCommitment,randomness:string,winner:string){
 const holders=holdersFrom(snapshot.accounts,BigInt(snapshot.supply),snapshot.excluded);
 if(canonical(holders)!==canonical(snapshot.holders)||hash(snapshot)!==commitment.snapshotHash||hash(RULES)!==commitment.rulesHash)throw new Error('Snapshot or rules do not match commitment');
 if(chooseWinner(holders,randomness,hash(commitment))!==winner)throw new Error('Winner does not match committed drawing');return true;
}
