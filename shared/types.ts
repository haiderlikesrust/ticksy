export interface Settings { paused:boolean; gasReserveSol:number; slippageBps:number; dailyCapUsd:number|null; enabledPacks:string[]; }
export interface Eligibility { eligible:boolean; balance:string; required:string; supply:string; percent:string; configured:boolean; weight?:number; }
export interface Prize { id:string; coinMint:string; mint:string; name:string; image:string; value:number; rarity:string; purchaseSignature:string; kind?:'watch'|'pokemon'|'unknown'; awardedAt?:number; buybackExpiresAt?:number; }
export interface BuybackQuote { status:'available'|'unavailable'|'error'; amount:number|null; checkedAt:number; }
export interface Holder { wallet:string; balance:string; weight:number; }
export interface Snapshot { version:1; mint:string; slot:number; supply:string; accounts:{address:string;owner:string;amount:string}[]; excluded:string[]; holders:Holder[]; createdAt:number; }
export interface DrawCommitment { version:1; roundId:string; snapshotHash:string; rulesHash:string; pack:{code:string;priceMicros:string}; beaconRound:number; opensAt:number; }
export interface RoundData { state:string; priceMicros:string; code:string; opensAt:number; snapshot?:Snapshot; commitment?:DrawCommitment; commitmentHash?:string; commitSignature?:string; beacon?:any; winner?:string; prize?:Prize; saleSignature?:string; saleMicros?:string; payoutSignature?:string; transferSignature?:string; kind?:'watch'|'pokemon'|'unknown'; error?:string; completedAt?:number; }
