import { createApp } from './app';
import { config } from './config';
const {app}=await createApp();await app.listen({port:config.PORT,host:config.HOST});console.log(`Ticksy service: http://${config.HOST}:${config.PORT} — real spending ${config.live?'enabled':'disabled'}`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{app.close().then(()=>process.exit(0));});
