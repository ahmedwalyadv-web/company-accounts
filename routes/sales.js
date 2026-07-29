const createTransactionRouter = require('./_transactionFactory');

module.exports = createTransactionRouter({
  table: 'sales',
  moduleKey: 'sales',
  direction: 'in',
  pageTitle: 'المبيعات',
  partyLabel: 'العميل',
  useReasonDropdown: false
});
