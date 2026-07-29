const createTransactionRouter = require('./_transactionFactory');

module.exports = createTransactionRouter({
  table: 'receipts',
  moduleKey: 'receipts',
  direction: 'in',
  pageTitle: 'استلام فلوس',
  partyLabel: 'المستلم منه',
  useReasonDropdown: false
});
