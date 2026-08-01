// Express 4 مبيعرفش يمسك الأخطاء اللي بتحصل جوه async route handlers لوحده،
// ولو حصل خطأ زي كده من غير ما نمسكه، السيرفر كله ممكن يقع (يوقف عن الشغل لكل اليوزرز)
// لحد ما حد يعمله Restart يدوي. الـ wrapper ده بيلف أي async handler
// ويحول أي خطأ لـ next(err) عشان الـ error handler العام في server.js يستقبله
// ويرجع رسالة خطأ بس من غير ما يوقف السيرفر.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
