import test from 'node:test';import assert from 'node:assert/strict';import {Keypair} from '@solana/web3.js';import nacl from 'tweetnacl';import bs58 from 'bs58';
import {openDatabase} from '../server/db';import {createApp} from '../server/app';import {classifyAsset} from '../server/settlement';
test('public prelaunch APIs contain no fabricated rewards; owner mutations require authentication',async()=>{
 const db=await openDatabase('','memory://'),{app}=await createApp({db,timers:false});try{
 const response=await app.inject('/api/overview');assert.equal(response.statusCode,200);const state=response.json();assert.equal(state.rewardCount,0);assert.deepEqual(state.recent,[]);assert.equal(state.activeRound,null);assert.equal(state.treasury.spendingEnabled,false);assert.equal(state.treasury.balanceMicros,null);
 assert.equal((await app.inject({method:'POST',url:'/api/admin/pause',payload:{paused:false}})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/api/auth/challenge',headers:{origin:'https://evil.example'},payload:{wallet:Keypair.generate().publicKey.toBase58()}})).statusCode,403);
 assert.equal((await app.inject('/api/leaderboard')).statusCode,200);
 }finally{await app.close();}
});
test('wallet login checks domain, signature and single-use challenge',async()=>{
 const db=await openDatabase('','memory://'),{app}=await createApp({db,timers:false}),wallet=Keypair.generate();try{
 const c=(await app.inject({method:'POST',url:'/api/auth/challenge',payload:{wallet:wallet.publicKey.toBase58()}})).json();assert.match(c.message,/Ticksy/);assert.match(c.message,/localhost:5173/);
 const signature=bs58.encode(nacl.sign.detached(new TextEncoder().encode(c.message),wallet.secretKey));
 const first=await app.inject({method:'POST',url:'/api/auth/verify',payload:{id:c.id,signature}});assert.equal(first.statusCode,200);assert.match(first.headers['set-cookie'] as string,/HttpOnly/);
 assert.notEqual((await app.inject({method:'POST',url:'/api/auth/verify',payload:{id:c.id,signature}})).statusCode,200);
 const logged=await app.inject({url:'/api/session',headers:{cookie:(first.headers['set-cookie'] as string).split(';')[0]}});assert.equal(logged.json().wallet,wallet.publicKey.toBase58());
 }finally{await app.close();}
});
test('ambiguous assets cannot be sold just because their pack or title mentions Pokemon',()=>{
 assert.equal(classifyAsset({name:'Pokemon Rolex pack'}),'unknown');assert.equal(classifyAsset({attributes:[{trait_type:'Brand',value:'Rolex'}]}),'watch');assert.equal(classifyAsset({attributes:[{trait_type:'Game',value:'Pokémon'}]}),'pokemon');assert.equal(classifyAsset({attributes:[{trait_type:'Brand',value:'Rolex'},{trait_type:'Game',value:'Pokémon'}]}),'unknown');
});
