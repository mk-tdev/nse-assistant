import {readFile,writeFile} from 'node:fs/promises';
const files=[['dashboardHtml','index.html'],['dashboardCss','dashboard.css'],['dashboardJs','dashboard.js'],['backtestHtml','backtest.html'],['backtestJs','backtest.js']];
const lines=await Promise.all(files.map(async([name,file])=>'export const '+name+'='+JSON.stringify(await readFile(new URL('../ui/'+file,import.meta.url),'utf8'))+';'));
await writeFile(new URL('../src/dashboard-assets.ts',import.meta.url),lines.join('\n')+'\n');
