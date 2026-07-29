const createTransactionRouter = require('./_transactionFactory');

module.exports = createTransactionRouter({
  table: 'purchases',
  moduleKey: 'purchases',
  direction: 'out',
  pageTitle: 'المشتريات',
  partyLabel: 'المورد',
  useReasonDropdown: false
});
