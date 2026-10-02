export const MICROS=1_000_000n;
export const RESERVE=500n*MICROS;
export const RULES={version:1,minimumBasisPoints:50,tiers:[[50,100],[100,110],[200,115],[300,120]],perWallet:true,holdingPeriodSeconds:0,reserveMicros:RESERVE.toString(),allocationBps:7500,packCapBps:2000,dailyBaseBps:2000,timezone:'Asia/Dubai',cardWinnerBps:5000,cardFallback:'nft',minimumIntervalMs:600_000,countdownMs:120_000};
export function weight(balance:bigint,supply:bigint){if(balance<0n||supply<=0n||balance>supply)return 0;const b=balance*10_000n;return b>=supply*300n?120:b>=supply*200n?115:b>=supply*100n?110:b>=supply*50n?100:0;}
export function eligible(amounts:string[],supply:string){return weight(amounts.reduce((s,n)=>s+BigInt(n),0n),BigInt(supply))>0;}
export function shortWallet(s:string){return `${s.slice(0,4)}…${s.slice(-4)}`;}
export const PACK_TIERS=[250,500,2000] as const;
export function allocation(amount:bigint){if(amount<0n)throw new Error('Negative income');return amount*3n/4n;}
export function splitSale(amount:bigint){if(amount<=0n)throw new Error('Sale must be positive');const winner=amount/2n;return{winner,treasury:amount-winner};}
export function dubaiDay(now:number){return Math.floor((now+14_400_000)/86_400_000)*86_400_000-14_400_000;}
export function feeRate(last10m:bigint,last1h:bigint){return last10m*6n<last1h?last10m*6n:last1h;}
export function intervalMs(cost:bigint,rate:bigint):number|null {const hourlyBudget=allocation(rate);if(hourlyBudget<=0n)return null;const value=(cost*3_600_000n+hourlyBudget-1n)/hourlyBudget;return Number(value>BigInt(Number.MAX_SAFE_INTEGER)?BigInt(Number.MAX_SAFE_INTEGER):value<600_000n?600_000n:value);}
export function canSpend(cost:bigint,available:bigint,budget:bigint,dayBase:bigint,dayIncome:bigint,dayCommitted:bigint){return cost>0n&&cost<=budget&&cost*5n<=available&&available-cost>=RESERVE&&dayCommitted+cost<=dayBase/5n+allocation(dayIncome);}
export function selectPack(completed:number,packs:{code:string;price:number}[],gate:(price:bigint)=>boolean,rate:bigint){const tier=(completed+1)%10===0?2000:(completed+1)%5===0?500:250;return [...packs].filter(p=>p.price<=tier&&gate(BigInt(p.price)*MICROS)&&(p.price===250||(intervalMs(BigInt(p.price)*MICROS,rate)??Infinity)<=3_600_000)).sort((a,b)=>b.price-a.price)[0]??null;}
