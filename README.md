# Ledger — MAD loan manager

Personal loan, cheque, income, and repayment tracking with a Node.js API and MySQL database. The dashboard retains Excel import/export, search, reminders, and weekly/monthly installment calculations.

## Run on this computer

Open PowerShell in this folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

Visit http://127.0.0.1:3000. Keep the terminal running. MySQL is a project-local process listening on port 3307; existing SQL Server installations are unaffected. Database files live in `.runtime/mysql-data`; credentials are in `.env`. Both are excluded from Git.

## Setup on another computer

Install Node.js 24 or newer and MySQL 8.4. Copy `.env.example` to `.env`, set your database connection and a random password of at least 20 characters, and run `npm install`. Set `DB_ADMIN_USER` and `DB_ADMIN_PASSWORD` for schema setup if needed, then run `npm run db:setup` and `npm start`. With a separately managed MySQL server, run `npm start` rather than the portable Windows launcher.

## Data and backups

On the first connection to an empty database, the dashboard offers to copy existing browser data into MySQL. It keeps the original localStorage backup. If the old page used another browser origin, export Excel from that page and import it into this app. Excel import replaces all app records after confirmation and validation. SheetJS 0.20.3 is bundled locally, so Excel backups work offline.

Money uses DECIMAL columns and cent-based validation. Writes run in a transaction and require the revision read by the client, preventing silent overwrites between tabs. A conflict requires reloading the page. Uncashed cheques reserve their amount against the loan total but do not reduce its cleared balance. Weekly budgeting uses a monthly estimate of 52/12 payments.

Export Excel regularly. Do not delete `.runtime` unless intentionally discarding the local database. The app is designed for private use on this computer, uses password-protected accounts, and binds to loopback. It should not be exposed publicly without HTTPS, production email delivery, managed secrets, monitoring, and a database backup plan.

## Checks

`npm test` runs server validation tests. With the server running and an empty database, `node scripts/verify.js` checks persistence and API safeguards. `node scripts/verify-browser.js` checks forms, reload persistence, Excel backup round-trip, and mobile layout using installed Brave (override `BROWSER_PATH` to use another Chromium browser). Verification creates and removes temporary records. The API provides `/api/health` and `/api/state`; state updates use `PUT /api/state` with the `X-Loan-Client: dashboard` header and the current revision. Database credentials never reach the browser.

## Multi-user mode

Ledger also supports cookie sessions, bcrypt password hashing, CSRF protection, user-scoped legacy dashboard state, shared agreements, repayment confirmation, notifications, contacts, password changes, and development password-reset tokens. The new tables are additive and are created by rerunning `npm run db:setup`; existing loan, payment, income, and audit tables are retained.

Authenticated finance endpoints are under `/api/auth/*` and `/api/finance/*`. Users can search an exact email address, request an agreement, and have the other account confirm or dispute it. Repayments remain pending until the other participant confirms them, and both accounts calculate the remaining balance from the same database records.

The browser dashboard includes agreement details and repayment history, counterparty confirmation, notifications, private contacts, profile and password changes, and development password reset. Senders can cancel their own pending requests but cannot confirm or dispute them; the same rule applies to repayment recorders. This prevents self-approval.

Run the repeatable two-user integration scenario with:

```powershell
npm run verify:multi
```

For a full two-browser UI check, run `npm run verify:shared-browser`. Both shared-workflow verifiers create temporary `example.com` accounts; remove those records afterward with `npm run cleanup:verifiers`.

For local password-reset testing, when `NODE_ENV` is not `production` and SMTP is not configured, the reset endpoint returns a one-time development token in its response. Do not enable that behavior in production. The application remains bound to loopback by default.

The portable database admin password is generated into `.runtime/admin.env`. To rerun schema setup against this local server, use `node --env-file=.env --env-file=.runtime/admin.env scripts/setup-db.js`. Keep both credential files private.
