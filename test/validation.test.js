import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateState} from '../server/validation.js';
import {canRespond} from '../server/finance.js';
const loan = {id:'loan-1',who:'Amina',type:'Person',direction:'I owe',total:1000,installment:100,frequency:'monthly',dueDate:'2026-01-31',method:'Cheque',notes:'',example:false};
const payment = {id:'payment-1',loanId:loan.id,date:'2026-01-01',amount:500,method:'Cheque',chequeNumber:'CH123',cashed:false};
const state = () => ({loans:[{...loan}],payments:[{...payment}],income:[]});
test('accepts valid uncashed cheque',() => assert.equal(validateState(state()).payments[0].cashed,false));
test('pending cheques count toward overpayment limit',() => { const s=state(); s.payments.push({...payment,id:'payment-2',amount:501}); assert.throws(() => validateState(s),/exceed/); });
test('rejects dangling payments',() => {const s=state(); s.payments[0].loanId='missing'; assert.throws(() => validateState(s),/Invalid payment/);});
test('rejects invalid calendar dates',() => {const s=state(); s.loans[0].dueDate='2026-02-30'; assert.throws(() => validateState(s),/Invalid loan/);});
test('rejects sub-cent money and duplicate IDs',() => {const s=state(); s.loans[0].total=1000.001; assert.throws(() => validateState(s)); s.loans[0].total=1000; s.loans.push({...loan}); assert.throws(() => validateState(s),/duplicate/);});
test('rejects future payments',() => {const s=state(); s.payments[0].date='2999-01-01'; assert.throws(() => validateState(s),/Invalid payment/);});
test('only the counterparty can confirm or dispute a shared record',() => {
  assert.equal(canRespond('creator','creator','confirm'),false);
  assert.equal(canRespond('creator','other','confirm'),true);
  assert.equal(canRespond('creator','creator','dispute'),false);
  assert.equal(canRespond('creator','other','dispute'),true);
});
test('only the creator can cancel a pending shared record',() => {
  assert.equal(canRespond('creator','creator','cancel'),true);
  assert.equal(canRespond('creator','other','cancel'),false);
});
