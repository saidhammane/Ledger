import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const base = 'http://127.0.0.1:3000';
const html = await readFile(new URL('../index.html',import.meta.url),'utf8');
new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const health = await fetch(base+'/api/health');
assert.equal(health.status,200);
assert.equal((await health.json()).database,'mysql');
const original = await (await fetch(base+'/api/state')).json();
assert.equal(original.loans.length,0,'Integration check requires an empty database; existing data will not be changed.');
assert.equal(original.income.length,0);
const loan = {id:'verify-loan',who:'Verification only',type:'Person',direction:'I owe',total:1000,installment:100,frequency:'monthly',dueDate:'2026-01-31',method:'Cheque',notes:'',example:false};
const payment = {id:'verify-payment',loanId:loan.id,date:'2026-01-01',amount:100,method:'Cheque',chequeNumber:'TEST',cashed:false};
const headers = {'Content-Type':'application/json','X-Loan-Client':'dashboard'};
const save = s => fetch(base+'/api/state',{method:'PUT',headers,body:JSON.stringify(s)});
let revision = original.revision;
try {
  let response = await save({...original,loans:[loan],payments:[payment]});
  assert.equal(response.status,200); revision = (await response.json()).revision;
  const read = await (await fetch(base+'/api/state')).json();
  assert.equal(read.loans[0].total,1000); assert.equal(read.payments[0].cashed,false);
  assert.equal(read.loans[0].dueDate,'2026-01-31');
  response = await save({...read,revision:original.revision}); assert.equal(response.status,409);
  response = await save({...read,payments:[{...payment,amount:1001}]}); assert.equal(response.status,400);
  response = await fetch(base+'/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(read)}); assert.equal(response.status,403);
  response = await save({...read,payments:[{...payment,cashed:true}],income:[{id:'verify-income',source:'Verification',date:'2026-01-01',amount:2500}]});
  assert.equal(response.status,200); revision = (await response.json()).revision;
  const persisted = await (await fetch(base+'/api/state')).json();
  assert.equal(persisted.payments[0].cashed,true); assert.equal(persisted.income[0].amount,2500);
  console.log('PASS: MySQL persistence, cheque clearance, income, revision conflicts, overpayment validation, request protection, and frontend syntax.');
} finally {
  const restored = await save({...original,revision});
  assert.equal(restored.status,200,'Verification cleanup failed');
}
