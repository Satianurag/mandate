import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
const origin='http://127.0.0.1:8410';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 for(const path of ['/#home','/workspace']){
  const context=await browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+path);await page.waitForFunction(()=>document.querySelector('#connectionText').textContent==='Connected');
  assert.equal(await page.locator('#loginPanel,#loginForm').count(),0);
  assert.equal(await page.locator('#workspace').isVisible(),true);
  assert.equal(await page.locator('[data-view]:visible').count(),1);
  assert.equal((await page.request.get(origin+'/api/agents')).status(),200);
  const cookie=(await context.cookies()).find(c=>c.name==='mandate_session');assert.ok(cookie?.httpOnly);assert.equal(cookie.sameSite,'Strict');
  await page.reload();await page.waitForFunction(()=>document.querySelector('#connectionText').textContent==='Connected');
  assert.deepEqual(errors,[]);await context.close();console.log('PASS fresh browser and reload: '+path);
 }
 // A regular background request is not a browser navigation and must not create a session.
 const response=await fetch(origin+'/');assert.equal(response.headers.get('set-cookie'),null);
 assert.equal((await fetch(origin+'/api/state')).status,401);
 const frame=await fetch(origin+'/',{headers:{'sec-fetch-mode':'navigate','sec-fetch-dest':'iframe','sec-fetch-site':'cross-site'}});assert.equal(frame.headers.get('set-cookie'),null);
 const proxy=await fetch(origin+'/',{headers:{'sec-fetch-mode':'navigate','sec-fetch-dest':'document','sec-fetch-user':'?1','x-forwarded-for':'203.0.113.2'}});assert.equal(proxy.headers.get('set-cookie'),null);
 console.log('PASS background, iframe and forwarded requests do not establish operator sessions');
}finally{await browser.close();}
