const createTransactionRouter = require('./_transactionFactory');

module.exports = createTransactionRouter({
  table: 'expenses',
  moduleKey: 'expenses',
  direction: 'out',
  pageTitle: 'المصروفات',
  partyLabel: 'المستلم',
  useReasonDropdown: true
});
