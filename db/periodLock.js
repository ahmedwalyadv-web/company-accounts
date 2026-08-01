const pool = require('./pool');

// بيتأكد هل الشهر اللي فيه التاريخ ده مقفول (تم عمل تقفيل شهري ليه) ولا لأ
async function isPeriodClosed(entryDate) {
  // لو التاريخ فاضي/غير صالح، نتعامل معاه كأنه "مقفول" احتياطًا عشان مانعملش
  // إدخال غلط في قاعدة البيانات بدل ما نسمح بيه غلط لإن التاريخ مش موجود
  if (!entryDate || isNaN(new Date(entryDate).getTime())) {
    return true;
  }
  const result = await pool.query(
    `SELECT 1 FROM monthly_closings WHERE period = date_trunc('month', $1::date)::date LIMIT 1`,
    [entryDate]
  );
  return result.rows.length > 0;
}

module.exports = { isPeriodClosed };
