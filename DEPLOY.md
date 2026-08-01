# خطوات نشر النظام أونلاين (مجانًا)

هنستخدم خدمتين مجانيتين:

- **Supabase** — قاعدة بيانات Postgres مجانية ودائمة (بياناتك محفوظة، مش بتتمسح)
- **Render** — لاستضافة السيرفر نفسه ويطلعلك رابط عام (https://your-app.onrender.com)

الخطوات كلها بدون أي كارت ائتمان.

---

## 1) عمل قاعدة البيانات (Supabase)

1. روح على [supabase.com](https://supabase.com) واعمل حساب مجاني (بإيميلك).
2. دوس **New Project**، اختار اسم للمشروع وباسورد لقاعدة البيانات (احفظه هتحتاجه).
3. استنى دقيقة لحد ما المشروع يتجهز.
4. من القائمة الجانبية: **Project Settings > Database**.
5. تحت **Connection string** اختار **URI** وانسخ الرابط (شكله كده تقريبًا):
   ```
   postgresql://postgres:[YOUR-PASSWORD]@db.xxxxxxxx.supabase.co:5432/postgres
   ```
6. حط الباسورد بتاعك مكان `[YOUR-PASSWORD]`. الرابط ده هو الـ `DATABASE_URL`.

---

## 2) رفع الكود على GitHub

1. اعمل حساب على [github.com](https://github.com) لو مش عندك.
2. اعمل **New repository** (اسمه مثلاً `company-accounts`).
3. ارفع مجلد المشروع كامل (كل الملفات ما عدا `node_modules`) على الريبو ده. أسهل طريقة: من صفحة الريبو دوس **uploading an existing file** واسحب الملفات، أو استخدم git من جهازك:
   ```bash
   git init
   git add .
   git commit -m "أول نسخة"
   git branch -M main
   git remote add origin https://github.com/USERNAME/company-accounts.git
   git push -u origin main
   ```

---

## 3) استضافة السيرفر (Render)

1. روح على [render.com](https://render.com) واعمل حساب مجاني (تقدر تسجل بحساب GitHub بتاعك مباشرة).
2. دوس **New > Web Service**.
3. اختار الريبو اللي رفعته (`company-accounts`).
4. في الإعدادات:
   - **Name:** أي اسم تحبه
   - **Region:** أقرب منطقة ليك
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. تحت **Environment Variables** ضيف المتغيرات دي:
   | المفتاح | القيمة |
   |---|---|
   | `DATABASE_URL` | الرابط اللي نسخته من Supabase في خطوة 1 |
   | `SESSION_SECRET` | أي نص عشوائي طويل (مثلاً `mySecretKey938271`) |
   | `ADMIN_PASSWORD` | كلمة مرور الأدمن اللي عايزها (مثلاً `Ahmed@2026`) |
   | `PGSSL` | `true` |
6. دوس **Create Web Service** واستنى لحد ما يخلص البناء (Deploy).

---

## 4) تجهيز قاعدة البيانات لأول مرة

بعد ما الخدمة تخلص Deploy وتشتغل:

1. من صفحة الخدمة في Render، دوس على **Shell** (تبويب فوق).
2. اكتب الأمر ده وسيبه يشتغل مرة واحدة بس:
   ```bash
   npm run db:init
   ```
3. هيظهرلك رسالة إن اليوزر أدمن اتعمل بنجاح.

---

## 5) خلاص، النظام شغال!

رابط النظام هيكون تحت اسم الخدمة في Render، شكله كده:

```
https://company-accounts.onrender.com
```

افتح الرابط، سجل دخول بـ:
- **اسم المستخدم:** admin
- **كلمة المرور:** اللي حطيتها في `ADMIN_PASSWORD`

وبعدين غيّر كلمة المرور من "تغيير كلمة المرور"، واعمل باقي اليوزرز من صفحة "المستخدمين".

---

### ملحوظة عن الخطة المجانية في Render

الخطة المجانية بتـ"تنام" لو محدش فتح الرابط لمدة 15 دقيقة، وأول طلب بعد كده بياخد شوية ثواني لحد ما يصحى. لو عايز يفضل شغال طول الوقت بسرعة، ترقية الخطة لـ Starter (مدفوعة بسعر بسيط) بتحل الموضوع ده. قاعدة البيانات على Supabase مش بتنام وبتفضل محتفظة بالبيانات في كل الأحوال.
