import type { Database } from './db';
export class PendingOperation extends Error {}
export class ReviewRequired extends Error {}
export class Jobs {
  constructor(readonly db:Database){}
  async get(id:string) {return (await this.db.query('SELECT * FROM jobs WHERE id=$1',[id])).rows[0]??null;}
  async put(id:string,kind:string,status:string,data:any,error:string|null=null) {await this.db.query(`INSERT INTO jobs(id,kind,status,data,created_at,updated_at,error) VALUES($1,$2,$3,$4,$5,$5,$6) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,data=EXCLUDED.data,updated_at=EXCLUDED.updated_at,error=EXCLUDED.error`,[id,kind,status,JSON.stringify(data),Date.now(),error]);}
  async error(id:string,error:unknown) {await this.db.query('UPDATE jobs SET error=$2,updated_at=$3 WHERE id=$1',[id,(error as Error).message,Date.now()]);}
}
