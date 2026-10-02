import { spawn } from 'node:child_process';
const children=[spawn(process.execPath,['--import','tsx','server/index.ts'],{stdio:'inherit',env:process.env}),spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5173','--strictPort'],{stdio:'inherit'})];
function stop(){for(const child of children)child.kill();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);for(const child of children)child.on('exit',()=>{stop();process.exit();});
