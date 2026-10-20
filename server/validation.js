export class ValidationError extends Error {}
export function validateState(s) {
  const bad = message => { throw new ValidationError(message); };
  const text = (v, max) => typeof v === 'string' && !!v.trim() && v.length <= max;
  const amount = v => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1e9 && Math.abs(v * 100 - Math.round(v * 100)) < .001;
  const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  const methods = ['Cash', 'Cheque', 'Bank'];
  if (!s || !['loans','payments','income'].every(k => Array.isArray(s[k]) && s[k].length <= 10000)) bad('Invalid dataset or too many records.');
  for (const rows of [s.loans,s.payments,s.income]) {
    const ids = new Set();
    for (const r of rows) {
      if (!r || !text(r.id,160) || ids.has(r.id)) bad('Missing or duplicate record ID.');
      ids.add(r.id);
    }
  }
  const loans = new Map(s.loans.map(l => [l.id,l]));
  const totals = new Map();
  for (const l of s.loans) {
    if (!text(l.who,160) || !['Person','Bank','Organization','Other'].includes(l.type) || !['I owe','Owed to me'].includes(l.direction) || !amount(l.total) || !amount(l.installment) || l.installment > l.total || !['weekly','monthly'].includes(l.frequency) || !(l.dueDate === '' || date(l.dueDate)) || !(l.method === '' || methods.includes(l.method)) || typeof l.notes !== 'string' || l.notes.length > 3000 || typeof l.example !== 'boolean') bad('Invalid loan.');
  }
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Casablanca',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  for (const p of s.payments) {
    if (!loans.has(p.loanId) || !date(p.date) || p.date > today || !amount(p.amount) || !methods.includes(p.method) || typeof p.cashed !== 'boolean' || typeof p.chequeNumber !== 'string' || p.chequeNumber.length > 80 || (p.method === 'Cheque' && !p.chequeNumber.trim())) bad('Invalid payment.');
    totals.set(p.loanId,(totals.get(p.loanId) || 0) + Math.round(p.amount * 100));
  }
  for (const [id,total] of totals) if (total > Math.round(loans.get(id).total * 100)) bad('Recorded payments exceed the loan total.');
  for (const i of s.income) if (!date(i.date) || !text(i.source,160) || !amount(i.amount)) bad('Invalid income.');
  return s;
}
