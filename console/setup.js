'use strict';
(()=>{
 let draft=null,loaded=false,saving=false;
 const fields={payerAddress:'setupPayer',rpcUrl:'setupRpc',facilitatorUrl:'setupFacilitator',ringKey:'setupRing'};
 const money={ceilingBaseUnits:'setupBudget',perCallBaseUnits:'setupPerCall',windowBaseUnits:'setupWindow'};
 function paint(d){for(const [key,id]of Object.entries(fields))$(id).value=d[key]??'';for(const [key,id]of Object.entries(money))$(id).value=units(d[key]);$('setupProject').value=d.vertex.project;$('setupLocation').value=d.vertex.location;$('setupModel').value=d.vertex.model;$('setupHours').value=d.durationHours;$('setupMinutes').value=d.windowMs/60000;}
 async function load(){if(loaded||!current)return;loaded=true;try{const data=await api('/api/setup-draft');draft=data.draft;paint(draft);}catch(e){loaded=false;message(e.message,true);}}
 function collect(){return{...draft,vertex:{project:$('setupProject').value.trim(),location:$('setupLocation').value.trim(),model:$('setupModel').value.trim()},...Object.fromEntries(Object.entries(fields).map(([key,id])=>[key,$(id).value.trim()])),...Object.fromEntries(Object.entries(money).map(([key,id])=>[key,baseUnits($(id).value.trim())])),durationHours:Number($('setupHours').value),windowMs:Number($('setupMinutes').value)*60000,toolIds:draft.toolIds};}
 async function save(){if(!draft)throw new Error('Settings are still loading');const result=await api('/api/setup-draft',collect(),'PUT');draft=result.draft;return draft;}
 for(const button of document.querySelectorAll('[data-save-setup]'))button.onclick=async()=>{if(saving)return;saving=true;button.disabled=true;try{await save();message('Settings saved. No funding or payment was made.');}catch(e){message(e.message,true);}finally{saving=false;button.disabled=false;}};
 $('setupReadLedger').onclick=async()=>{const b=$('setupReadLedger');b.disabled=true;$('setupDeviceStatus').textContent='Unlock Ledger, open Ethereum, and confirm the address on the device.';try{const result=await api('/api/setup-device',{});$('setupPayer').value=result.address;$('setupDeviceStatus').textContent='Address confirmed. No payment was signed.';}catch(e){$('setupDeviceStatus').textContent=e.message;}finally{b.disabled=false;}};
 $('setupPrepare').onclick=async()=>{const b=$('setupPrepare');b.disabled=true;$('setupDeviceStatus').textContent='Preparing your encrypted spending wallet…';try{await save();await api('/api/setup-prepare',{confirm:'prepare_mainnet_wallet'});$('setupDeviceStatus').textContent='Wallet prepared. Review the exact funding amount on Ledger to enable paid work.';await refresh();showDashboardView('authority');}catch(e){$('setupDeviceStatus').textContent=e.message;}finally{b.disabled=false;}};
 window.addEventListener('mandate:state',()=>void load());void load();
})();
