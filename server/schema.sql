CREATE TABLE IF NOT EXISTS app_meta (
  id TINYINT PRIMARY KEY,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0
);
INSERT IGNORE INTO app_meta (id, revision) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS loans (
  id VARCHAR(160) PRIMARY KEY,
  who VARCHAR(160) NOT NULL,
  type ENUM('Person','Bank','Organization','Other') NOT NULL,
  direction ENUM('I owe','Owed to me') NOT NULL,
  total DECIMAL(12,2) NOT NULL,
  installment DECIMAL(12,2) NOT NULL,
  frequency ENUM('monthly','weekly') NOT NULL,
  dueDate DATE NULL,
  method ENUM('Cash','Cheque','Bank') NULL,
  notes TEXT NOT NULL,
  example BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK (total > 0 AND installment > 0 AND installment <= total)
);
CREATE TABLE IF NOT EXISTS payments (
  id VARCHAR(160) PRIMARY KEY,
  loanId VARCHAR(160) NOT NULL,
  date DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  method ENUM('Cash','Cheque','Bank') NOT NULL,
  chequeNumber VARCHAR(80) NOT NULL DEFAULT '',
  cashed BOOLEAN NOT NULL,
  FOREIGN KEY (loanId) REFERENCES loans(id) ON DELETE CASCADE,
  INDEX payments_loan_date (loanId, date),
  CHECK (amount > 0)
);
CREATE TABLE IF NOT EXISTS income (
  id VARCHAR(160) PRIMARY KEY,
  date DATE NOT NULL,
  source VARCHAR(160) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  INDEX income_date (date),
  CHECK (amount > 0)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  revision BIGINT UNSIGNED NOT NULL,
  changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  summary JSON NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX users_email (email)
);

CREATE TABLE IF NOT EXISTS user_legacy_state (
  user_id CHAR(36) PRIMARY KEY,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  state JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  id CHAR(64) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX sessions_user_expiry (user_id, expires_at)
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id CHAR(64) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX reset_user_expiry (user_id, expires_at)
);

CREATE TABLE IF NOT EXISTS contacts (
  id CHAR(36) PRIMARY KEY,
  owner_user_id CHAR(36) NOT NULL,
  contact_user_id CHAR(36) NULL,
  name VARCHAR(160) NOT NULL,
  email VARCHAR(254) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY contacts_owner_email (owner_user_id, email),
  INDEX contacts_owner (owner_user_id)
);

CREATE TABLE IF NOT EXISTS agreements (
  id CHAR(36) PRIMARY KEY,
  creditor_user_id CHAR(36) NOT NULL,
  debtor_user_id CHAR(36) NOT NULL,
  contact_id CHAR(36) NULL,
  created_by CHAR(36) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'MAD',
  description VARCHAR(3000) NOT NULL,
  category VARCHAR(80) NOT NULL DEFAULT 'General',
  due_date DATE NULL,
  method ENUM('Cash','Cheque','Bank') NULL,
  reference VARCHAR(160) NOT NULL DEFAULT '',
  status ENUM('Pending','Confirmed','Partially paid','Paid','Disputed','Cancelled') NOT NULL DEFAULT 'Pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  confirmed_at DATETIME NULL,
  FOREIGN KEY (creditor_user_id) REFERENCES users(id),
  FOREIGN KEY (debtor_user_id) REFERENCES users(id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id),
  CHECK (amount > 0 AND creditor_user_id <> debtor_user_id),
  INDEX agreements_creditor (creditor_user_id, status, created_at),
  INDEX agreements_debtor (debtor_user_id, status, created_at)
);

CREATE TABLE IF NOT EXISTS repayments (
  id CHAR(36) PRIMARY KEY,
  agreement_id CHAR(36) NOT NULL,
  created_by CHAR(36) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'MAD',
  method ENUM('Cash','Cheque','Bank') NOT NULL,
  reference VARCHAR(160) NOT NULL DEFAULT '',
  transaction_date DATE NOT NULL,
  status ENUM('Pending','Confirmed','Disputed','Cancelled') NOT NULL DEFAULT 'Pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  confirmed_at DATETIME NULL,
  FOREIGN KEY (agreement_id) REFERENCES agreements(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  CHECK (amount > 0),
  INDEX repayments_agreement (agreement_id, status, transaction_date)
);

CREATE TABLE IF NOT EXISTS notifications (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  agreement_id CHAR(36) NULL,
  repayment_id CHAR(36) NULL,
  kind VARCHAR(80) NOT NULL,
  title VARCHAR(200) NOT NULL,
  body VARCHAR(1000) NOT NULL,
  read_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (agreement_id) REFERENCES agreements(id) ON DELETE CASCADE,
  FOREIGN KEY (repayment_id) REFERENCES repayments(id) ON DELETE CASCADE,
  INDEX notifications_user (user_id, read_at, created_at)
);

CREATE TABLE IF NOT EXISTS financial_audit (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_user_id CHAR(36) NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id CHAR(36) NOT NULL,
  action VARCHAR(80) NOT NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX financial_audit_entity (entity_type, entity_id, created_at)
);
