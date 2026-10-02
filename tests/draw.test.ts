import test from 'node:test';import assert from 'node:assert/strict';import { Keypair } from '@solana/web3.js';
import { holdersFrom,hash,canonical,chooseWinner,verifyDrawMath,Beacon,QUICKNET,QUICKNET_KEY } from '../server/draw';
import { RULES } from '../shared/policy';import type {Snapshot,DrawCommitment} from '../shared/types';
const key=()=>Keypair.generate().publicKey.toBase58();
test('all token accounts aggregate by owner; exclusions are explicit and completeness is enforced',()=>{
 const a=key(),b=key(),accounts=[{address:key(),owner:a,amount:'250'},{address:key(),owner:a,amount:'250'},{address:key(),owner:b,amount:'99500'}];
 const holders=holdersFrom(accounts,100000n,[b]);assert.equal(holders.length,1);assert.equal(holders[0].wallet,a);assert.equal(holders[0].weight,100);
 assert.throws(()=>holdersFrom(accounts.slice(1),100000n,[]),/Incomplete/);assert.throws(()=>holdersFrom([...accounts,accounts[0]],100000n,[]),/Duplicate/);
});
test('snapshot hashes are key-order stable; winner remains reproducible and tampering fails',()=>{
 const a=key(),b=key(),accounts=[{address:key(),owner:a,amount:'3000'},{address:key(),owner:b,amount:'97000'}];
 const snapshot:Snapshot={version:1,mint:key(),slot:500,supply:'100000',accounts,excluded:[],holders:holdersFrom(accounts,100000n,[]),createdAt:100};
 const commit:DrawCommitment={version:1,roundId:'test',snapshotHash:hash(snapshot),rulesHash:hash(RULES),pack:{code:'ewatch_250',priceMicros:'250000000'},beaconRound:100,opensAt:200};
 const random='a'.repeat(64),winner=chooseWinner(snapshot.holders,random,hash(commit));assert.equal(chooseWinner(snapshot.holders,random,hash(commit)),winner);assert.equal(verifyDrawMath(snapshot,commit,random,winner),true);
 assert.equal(hash({b:2,a:1}),hash({a:1,b:2}));assert.throws(()=>verifyDrawMath({...snapshot,slot:501},commit,random,winner),/match/);assert.throws(()=>chooseWinner([],random,hash(commit)),/eligible/);
});
test('many independent deterministic seeds approximately respect 100:120 weighting',()=>{
 const a=key(),b=key(),holders=[{wallet:a,balance:'500',weight:100},{wallet:b,balance:'3000',weight:120}];let bWins=0;
 for(let i=0;i<10000;i++)if(chooseWinner(holders,hash(i),hash('commit'))===b)bWins++;
 assert.ok(bWins>5200&&bWins<5700,`Unexpected weighted distribution ${bWins}`);
});
test('beacon client rejects a relay with a substituted network key',async()=>{
 const original=globalThis.fetch;try{globalThis.fetch=async()=>new Response(JSON.stringify({hash:QUICKNET,public_key:'bad',period:3,genesis_time:1692803367}));await assert.rejects(new Beacon().info(),/Unexpected/);}finally{globalThis.fetch=original;}
});
