import test from 'node:test';import assert from 'node:assert/strict';import {openDatabase,migrate,atomic,Serial} from '../server/db';import {recordIncome,accounting} from '../server/accounting';import {MICROS as M,dubaiDay} from '../shared/policy';
test('settled income is credited once and buybacks never inflate fee rate or budget',async()=>{
 const db=await openDatabase('','memory://');await migrate(db);try{const now=Date.now();await recordIncome(db,'f1','fee',1000n*M,'tx1',now);await recordIncome(db,'f1','fee',1000n*M,'tx1',now);await recordIncome(db,'f2','seed',1000n*M,'tx1',now);
 await db.query("INSERT INTO ledger(id,kind,amount_micros,created_at) VALUES('sale','buyback',180000000,$1),('return','treasury-return',90000000,$1)",[now]);
 let a=await accounting(db,now);assert.equal(a.budget,750n*M);assert.equal(a.last1h,1000n*M);
 await recordIncome(db,'seed','seed',1000n*M,'tx-seed',now);a=await accounting(db,now);assert.equal(a.budget,1500n*M);assert.equal(a.dayIncome,1000n*M);
 }finally{await db.close();}
});
test('one unsettled round and reservations survive engine replacement; release restores budget',async()=>{
 const db=await openDatabase('','memory://');await migrate(db);try{const now=Date.now();await recordIncome(db,'seed','seed',2000n*M,'tx',now);
 await atomic(db,async()=>{await db.query("INSERT INTO rounds(id,status,data,created_at) VALUES('r','snapshot','{}',$1)",[now]);await db.query("INSERT INTO reservations(round_id,amount_micros,day,status) VALUES('r',250000000,$1,'reserved')",[dubaiDay(now)]);});
 let a=await accounting(db,now);assert.equal(a.budget,1250n*M);assert.equal(a.reserved,250n*M);assert.equal(a.dayCommitted,250n*M);
 await assert.rejects(db.query("INSERT INTO rounds(id,status,data,created_at) VALUES('other','snapshot','{}',$1)",[now]));
 await db.query("UPDATE rounds SET status='cancelled' WHERE id='r'");await db.query("UPDATE reservations SET status='released' WHERE round_id='r'");a=await accounting(db,now);assert.equal(a.budget,1500n*M);assert.equal(a.reserved,0n);
 }finally{await db.close();}
});
test('winner payout obligations remain reserved until payout is recorded',async()=>{const db=await openDatabase('','memory://');await migrate(db);try{await db.query("INSERT INTO rounds(id,status,data,created_at) VALUES('r','paying',$1,$2)",[JSON.stringify({saleMicros:'180000000'}),Date.now()]);assert.equal((await accounting(db)).obligations,90n*M);await db.query("UPDATE rounds SET data=data||'{\"payoutSignature\":\"settled\"}'::jsonb WHERE id='r'");assert.equal((await accounting(db)).obligations,0n);}finally{await db.close();}});
test('serial coordinator never overlaps financial work',async()=>{const serial=new Serial();let running=0,max=0;await Promise.all(Array.from({length:30},()=>serial.run(async()=>{running++;max=Math.max(max,running);await Promise.resolve();running--;})));assert.equal(max,1);});
