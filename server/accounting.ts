import type { Database } from './db';
import { atomic } from './db';
import { allocation,dubaiDay } from '../shared/policy';
export async function recordIncome(db:Database,id:string,kind:'fee'|'seed',amount:bigint,signature:string,at=Date.now()){
 if(amount<=0n)throw new Error('Income must be a positive settled amount');
 await atomic(db,async()=>{const row=await db.query('INSERT INTO ledger(id,kind,amount_micros,signature,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',[id,kind,amount.toString(),signature,at]);if(row.rows.length)await db.query("INSERT INTO ledger(id,kind,amount_micros,created_at,data) VALUES($1,'allocation',$2,$3,$4)",[`${id}:allocation`,allocation(amount).toString(),at,JSON.stringify({source:id})]);});
}
export async function accounting(db:Database,now=Date.now()){
 const day=dubaiDay(now);const result=(await db.query(`SELECT
 COALESCE(SUM(CASE WHEN kind='allocation' THEN amount_micros ELSE 0 END),0)::text AS allocated,
 COALESCE(SUM(CASE WHEN kind='fee' AND created_at>$1 THEN amount_micros ELSE 0 END),0)::text AS ten,
 COALESCE(SUM(CASE WHEN kind='fee' AND created_at>$2 THEN amount_micros ELSE 0 END),0)::text AS hour,
 COALESCE(SUM(CASE WHEN kind='fee' AND created_at>=$3 THEN amount_micros ELSE 0 END),0)::text AS day_income FROM ledger`,[now-600_000,now-3_600_000,day])).rows[0];
 const reserve=(await db.query(`SELECT COALESCE(SUM(CASE WHEN status<>'released' THEN amount_micros ELSE 0 END),0)::text AS used, COALESCE(SUM(CASE WHEN status='reserved' THEN amount_micros ELSE 0 END),0)::text AS outstanding, COALESCE(SUM(CASE WHEN status<>'released' AND day=$1 THEN amount_micros ELSE 0 END),0)::text AS day_committed FROM reservations`,[day])).rows[0];
 const obligations=(await db.query("SELECT COALESCE(SUM((data->>'saleMicros')::bigint/2),0)::text AS amount FROM rounds WHERE status<>'complete' AND data->>'saleMicros' IS NOT NULL AND data->>'payoutSignature' IS NULL")).rows[0];
 return{day,budget:BigInt(result.allocated)-BigInt(reserve.used),last10m:BigInt(result.ten),last1h:BigInt(result.hour),dayIncome:BigInt(result.day_income),dayCommitted:BigInt(reserve.day_committed),reserved:BigInt(reserve.outstanding),obligations:BigInt(obligations.amount)};
}
