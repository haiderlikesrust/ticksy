import test from 'node:test';
import assert from 'node:assert/strict';
import { MICROS as M,RESERVE,weight,allocation,splitSale,dubaiDay,feeRate,intervalMs,canSpend,selectPack } from '../shared/policy';
test('eligibility thresholds and independent highest tier weights use integer math',()=>{
 const supply=100000n;
 for(const [balance,w] of [[499,0],[500,100],[999,100],[1000,110],[1999,110],[2000,115],[2999,115],[3000,120],[100000,120]])assert.equal(weight(BigInt(balance),supply),w);
 assert.equal(weight(5n,0n),0);assert.equal(weight(-1n,supply),0);assert.equal(weight(100001n,supply),0);
 assert.equal(weight(3000n,supply)+weight(2000n,supply),235);assert.equal(6*weight(500n,supply),600);
});
test('$2,000 treasury admits a $250 opening but not $500/$1,000 or a second $250 without income',()=>{
 assert.equal(canSpend(250n*M,2000n*M,1500n*M,2000n*M,0n,0n),true);
 for(const cost of [500n,1000n])assert.equal(canSpend(cost*M,2000n*M,1500n*M,2000n*M,0n,0n),false);
 assert.equal(canSpend(250n*M,1750n*M,1250n*M,2000n*M,0n,250n*M),false);
 assert.equal(canSpend(250n*M,1750n*M,1250n*M,2000n*M,200n*M,250n*M),true);
});
test('reserve, allocation and obligations never become imaginary money',()=>{
 assert.equal(allocation(1001n),750n);assert.deepEqual(splitSale(180n*M),{winner:90n*M,treasury:90n*M});assert.deepEqual(splitSale(11n),{winner:5n,treasury:6n});
 assert.equal(canSpend(250n*M,749n*M,1000n*M,5000n*M,0n,0n),false);
 assert.equal(canSpend(250n*M,2000n*M,249n*M,2000n*M,0n,0n),false);assert.equal(RESERVE,500n*M);
});
test('fee spikes, collapse and minimum cadence are bounded',()=>{
 assert.equal(feeRate(100n*M,20n*M),20n*M);assert.equal(feeRate(0n,1000n*M),0n);
 assert.equal(intervalMs(250n*M,0n),null);assert.equal(intervalMs(250n*M,10000n*M),600000);assert.equal(intervalMs(250n*M,100n*M),12000000);
});
test('premium rotation is gated by budget and hourly sustainability',()=>{
 const packs=[{code:'a',price:250},{code:'b',price:500},{code:'c',price:2000}];
 assert.equal(selectPack(4,packs,()=>true,1000n*M)?.price,500);
 assert.equal(selectPack(9,packs,()=>true,4000n*M)?.price,2000);
 assert.equal(selectPack(9,packs,c=>c<=500n*M,2000n*M)?.price,500);
 assert.equal(selectPack(9,packs,()=>true,100n*M)?.price,250);assert.equal(selectPack(0,packs,()=>false,100n*M),null);
});
test('daily window is midnight Asia/Dubai, independent of host timezone',()=>{
 assert.equal(dubaiDay(Date.parse('2026-10-02T19:59:59Z')),Date.parse('2026-10-01T20:00:00Z'));
 assert.equal(dubaiDay(Date.parse('2026-10-02T20:00:00Z')),Date.parse('2026-10-02T20:00:00Z'));
});
