import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.BASE_URL || 'http://127.0.0.1:3000';
const stamp = Date.now();
const creditorEmail = `browser-creditor-${stamp}@example.com`;
const debtorEmail = `browser-debtor-${stamp}@example.com`;
const password = 'Browser-shared-password-123';
const browser = await chromium.launch({executablePath:process.env.BROWSER_PATH || 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',headless:true});
const creditor = await browser.newPage();
const debtor = await browser.newPage();
const errors = [];
for (const page of [creditor, debtor]) page.on('pageerror', error => errors.push(error.message));

async function register(page, name, email) {
  await page.goto(base);
  await page.locator('[data-auth-tab="register"]').click();
  await page.locator('[data-auth-form="register"] [name=name]').fill(name);
  await page.locator('[data-auth-form="register"] [name=email]').fill(email);
  await page.locator('[data-auth-form="register"] [name=password]').fill(password);
  await page.locator('[data-auth-form="register"] button.primary').click();
  await page.locator('#connectionStatus').filter({hasText:'Database connected'}).waitFor();
}

try {
  await register(creditor, 'Browser Creditor', creditorEmail);
  await register(debtor, 'Browser Debtor', debtorEmail);
  await creditor.locator('#agreementForm [name=counterpartEmail]').fill(debtorEmail);
  await creditor.locator('#agreementForm [name=amount]').fill('1000');
  await creditor.locator('#agreementForm [name=description]').fill('Shared browser verification');
  await creditor.locator('#agreementForm button.primary').click();
  const creditorRow = creditor.locator('#sharedRows .shared-item').filter({hasText:'Shared browser verification'});
  try { await creditorRow.waitFor(); } catch (error) {
    console.error('Agreement UI diagnostics:', await creditor.locator('#notice').textContent(), await creditor.locator('#sharedRows').textContent(), errors);
    throw error;
  }
  await creditorRow.getByRole('button',{name:'Cancel request'}).waitFor();
  assert.equal(await creditorRow.getByRole('button',{name:'Confirm'}).count(),0);

  await debtor.locator('#refreshShared').click();
  const debtorRow = debtor.locator('#sharedRows .shared-item').filter({hasText:'Shared browser verification'});
  await debtorRow.getByRole('button',{name:'Confirm'}).click();
  await debtorRow.getByText('Confirmed',{exact:false}).waitFor();
  await debtorRow.getByRole('button',{name:'Details'}).click();
  await debtor.locator('#repaymentForm [name=amount]').fill('300');
  await debtor.locator('#repaymentForm [name=method]').selectOption('Bank');
  await debtor.locator('#repaymentForm [name=reference]').fill('TEST-TRANSFER');
  await debtor.locator('#repaymentForm button.primary').click();
  await debtor.locator('#repaymentRows').getByText('Pending',{exact:true}).waitFor();
  assert.equal(await debtor.locator('#repaymentRows').getByRole('button',{name:'Confirm'}).count(),0);
  await debtor.locator('[data-close="sharedDialog"]').click();

  await creditor.locator('#refreshShared').click();
  await creditorRow.getByRole('button',{name:'Details'}).click();
  await creditor.locator('#repaymentRows').getByRole('button',{name:'Confirm'}).click();
  await creditor.locator('#repaymentRows').getByText('Confirmed',{exact:true}).waitFor();
  await creditor.locator('#sharedDetail').getByText('700.00 MAD',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS: browser completed agreement review, repayment entry, counterparty confirmation, and synchronized balance display.');
} finally {
  await browser.close();
}
