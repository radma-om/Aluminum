# مهمة: تصحيح نطاق الإنتاج في التوثيق إلى calcshutter.radma.co

**المستودع:** `radma-om/Aluminum`
**الفرع المقترح:** `docs/fix-production-domain`
**التاريخ:** 2026-11-25
**مهام مرتبطة في المستودع الآخر:** لا يوجد

## الهدف
نطاق الإنتاج الفعلي هو `https://calcshutter.radma.co`، وهذا مؤكد من hPanel ومن `/healthz` (الإصدار 3.60.0) في 2026-11-25. أما `calc.radma.co` فلا يفتح أصلاً. التوثيق يذكر النطاق الخطأ، وجلسات التخطيط والربط تعتمد عليه.

## الوضع الحالي
- `CLAUDE.md:10`: «يُنشر تلقائياً على الإنتاج (`calc.radma.co` على Hostinger)».
- `docs/STATUS.md:8`: «**الإنتاج:** `https://calc.radma.co`».
- `docs/STATUS.md:72`: سؤال مفتوح عن تأكيد نطاق الإنتاج.
- `README.md:1389-1402`: خطوات Hostinger وجدول الروابط تذكر `calc.radma.co`.

## المطلوب
1. `CLAUDE.md:10`: استبدل `calc.radma.co` بـ `calcshutter.radma.co`.
2. `docs/STATUS.md:8`: «**الإنتاج:** `https://calcshutter.radma.co` (Hostinger Business، نشر تلقائي من `main`)».
3. `docs/STATUS.md:72`: احذف السؤال المفتوح عن النطاق، فقد حُسم.
4. `README.md` في قسم Hostinger فقط (الأسطر 1389-1402 تقريباً): استبدل `calc.radma.co` بـ `calcshutter.radma.co` في الخطوات 4 و5 و6 وفي جدول الروابط.
5. `docs/STATUS.md`: سطر في «آخر التغييرات».

## ما يجب عدم تغييره
- أي كود أو اختبار أو إعداد، فالتعديل توثيق فقط.
- `README.md:1419` (مثال تثبيت VPS بنطاق افتراضي)، يبقى كما هو.
- ملفات `docs/tasks/` القديمة، فهي سجل تاريخي ولا تُعدَّل.
- الإصدار في `package.json`.

## العلاقة بالمستودع الآخر
لا شيء يتغير في الربط. للمرجع فقط: نظام بانوراما يستخدم `ALUMINUM_BASE_URL=https://calcshutter.radma.co` (عقد الربط الإصدار 1.2).

## معايير القبول
- [ ] `grep -rn "calc\.radma\.co" CLAUDE.md docs/STATUS.md` لا يعيد شيئاً.
- [ ] قسم Hostinger في `README.md` يذكر `calcshutter.radma.co` فقط.
- [ ] لا تغيير في أي ملف خارج `CLAUDE.md` و`docs/STATUS.md` و`README.md`.
- [ ] الاختبارات تنجح
- [ ] تحديث `docs/STATUS.md`
- [ ] Pull Request على الفرع المقترح (لا push مباشر إلى main)
