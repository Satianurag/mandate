import {chromium} from '@playwright/test';import {readFile,mkdir} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
const token=(await readFile('state/mainnet/operator/operator-token','utf8')).trim();await page.goto('http://127.0.0.1:8410/#token='+token);await page.waitForSelector('body.is-connected');await page.waitForTimeout(1500);
await mkdir('.live-results/mainnet',{recursive:true});
for(const view of ['home','agents','history','authority','evidence','settings']){await page.locator(`nav [data-navigate="${view}"]`).click();await page.screenshot({path:`.live-results/mainnet/${view}.png`,fullPage:true});console.log(view,await page.locator('[data-view]:visible').count(),await page.evaluate(()=>({width:innerWidth,content:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight})));}
console.log('browser errors',errors);await browser.close();if(errors.length)process.exitCode=1;
