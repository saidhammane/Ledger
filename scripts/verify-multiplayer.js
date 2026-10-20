import assert from 'node:assert/strict';

const base = process.env.BASE_URL || 'http://127.0.0.1:3000';
const makeClient = () => ({cookie: ''});
const request = async (client, path, options = {}) => {
  const headers = {'X-Loan-Client': 'dashboard', ...(client.cookie ? {Cookie: client.cookie} : {}), ...(options.body ? {'Content-Type': 'application/json'} : {}), ...(options.headers || {})};
  const csrf = (client.cookie.match(/(?:^|; )ledger_csrf=([^;]+)/) || [])[1];
  if (options.method && options.method !== 'GET' && csrf) headers['X-CSRF-Token'] = decodeURIComponent(csrf);
  const response = await fetch(base + path, {...options, headers});
  for (const value of response.headers.getSetCookie?.() || []) {
    const pair = value.split(';')[0];
    const name = pair.slice(0, pair.indexOf('='));
    client.cookie = client.cookie.split('; ').filter(item => !item.startsWith(name + '=')).concat(pair).filter(Boolean).join('; ');
  }
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  return {status: response.status, body};
};

const said = makeClient();
const farouk = makeClient();
const stamp = Date.now();
const saidEmail = `said-${stamp}@example.com`;
const faroukEmail = `farouk-${stamp}@example.com`;
const password = 'Ledger-test-password-123';

let response = await request(said, '/api/auth/register', {method: 'POST', body: JSON.stringify({name: 'Said', email: saidEmail, password})});
assert.equal(response.status, 201);
response = await request(farouk, '/api/auth/register', {method: 'POST', body: JSON.stringify({name: 'Farouk', email: faroukEmail, password})});
assert.equal(response.status, 201);
response = await request(said, '/api/finance/agreements', {method: 'POST', body: JSON.stringify({counterpartEmail: faroukEmail, direction: 'owed_to_me', amount: 1000, description: 'Loan', category: 'Personal', method: 'Cash', reference: ''})});
assert.equal(response.status, 201);
const agreementId = response.body.id;
response = await request(said, `/api/finance/agreements/${agreementId}/respond`, {method: 'POST', body: JSON.stringify({decision: 'confirm'})});
assert.equal(response.status, 403, 'agreement sender must not self-confirm');
response = await request(farouk, `/api/finance/agreements/${agreementId}/respond`, {method: 'POST', body: JSON.stringify({decision: 'confirm'})});
assert.equal(response.status, 200);
response = await request(farouk, `/api/finance/agreements/${agreementId}/repayments`, {method: 'POST', body: JSON.stringify({amount: '300.00', method: 'Cash', transactionDate: new Date().toISOString().slice(0, 10), reference: ''})});
assert.equal(response.status, 201);
const repaymentId = response.body.id;
response = await request(farouk, `/api/finance/repayments/${repaymentId}/respond`, {method: 'POST', body: JSON.stringify({decision: 'confirm'})});
assert.equal(response.status, 403, 'repayment recorder must not self-confirm');
response = await request(said, `/api/finance/repayments/${repaymentId}/respond`, {method: 'POST', body: JSON.stringify({decision: 'confirm'})});
assert.equal(response.status, 200);
const saidAgreement = await request(said, `/api/finance/agreements/${agreementId}`);
const faroukAgreement = await request(farouk, `/api/finance/agreements/${agreementId}`);
assert.equal(saidAgreement.body.agreement.remainingAmount, '700.00');
assert.equal(faroukAgreement.body.agreement.remainingAmount, '700.00');
const notifications = await request(said, '/api/finance/notifications');
assert.ok(notifications.body.notifications.some(item => item.repayment_id === repaymentId));
const dashboard = await request(farouk, '/api/finance/dashboard');
assert.equal(Number(dashboard.body.summary.money_owe), 700);
assert.equal(Number(dashboard.body.summary.repayments_made), 300);
console.log('PASS: two users completed the counterparty-confirmed workflow, self-approval was rejected, notifications were created, and both observed a synchronized 700.00 MAD balance.');
