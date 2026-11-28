# مهمة: إرسال حدث أمر العمل عند الجدولة من نافذة «تعديل / جدولة»

**المستودع:** `radma-om/Aluminum`
**الفرع المقترح:** `fix/work-order-schedule-events`
**التاريخ:** 2026-11-28
**مهام مرتبطة في المستودع الآخر:** `2026-11-28-panorama-post-activation-fixes.md` في `panorama-commerce`. **تُنفَّذ هذه المهمة أولاً.**

## الهدف
في تجربة التفعيل (2026-11-28، أمر العمل `WO-2026-0006` القادم من بانوراما) جُدول الأمر من لوحة ردما وأُسند له فني، فصارت حالته «مجدول»، لكن بانوراما لم يصلها أي حدث. العميل والموظف في بانوراما لا يريان الموعد إلا بعد السحب الاحتياطي كل ساعة.

## الوضع الحالي
- `PATCH /work-orders/:id` في `src/server.js` يستدعي `workorders.update(...)`. هذه الدالة تغيّر الحالة `new → scheduled` عند اكتمال الفني والموعد، و`scheduled → new` عند زوال أحدهما، وتغيّر الموعد والفني. **المسار لا يستدعي `webhooks.emit` إطلاقاً.**
- الحدث `work_order.status_changed` يُرسل اليوم فقط من: `POST /work-orders/:id/status`، و`POST /work-orders/:id/cancel`، وإلغاء أوامر الفاتورة الملغاة.
- `work_order.created` يعمل (وصل لبانوراما في التجربة)، وقناة الـ Webhook سليمة.
- أحداث `work_order.*` تُجرَّب مرة واحدة، فهي ليست في `RETRY_EVENTS`.

## المطلوب
1. **إصلاح:** في `PATCH /work-orders/:id`، إذا اختلفت `order.status` عن `before.status` بعد التحديث، أرسل `work_order.status_changed` بنفس البيانات التي يرسلها `POST /work-orders/:id/status` (كائن أمر العمل كما هو).
2. **حدث جديد `work_order.updated`:** يُرسل من المسار نفسه إذا **لم تتغير الحالة** وتغيّر أحد الحقول: `scheduled_date`، `scheduled_time`، `technician_id`. البيانات هي كائن أمر العمل نفسه، بنفس شكل `work_order.status_changed`.
   - لا يُرسل الحدثان معاً لنفس التعديل: تغيّرت الحالة ← `status_changed` فقط.
   - تعديل العنوان أو الوصف وحده لا يرسل شيئاً.
   - أضفه إلى `EVENTS` وإلى `RETRY_EVENTS` (إعادة بعد 1 ثم 5 ثم 15 دقيقة، بنفس `id`)، وإلى قائمة الأحداث في صفحة Webhooks.
3. **مراجعة شاملة:** ابحث عن كل موضع يغيّر `work_orders.status` (مثل `technicianReported`، `cancelOrphans`، اعتماد طلبات المواعيد، وأي مسار آخر)، وتأكد أن كل تغيير حالة فعلي يرسل `work_order.status_changed`. اذكر في وصف الـ PR ما وجدته وما أضفته.
4. اختبارات: PATCH يغيّر الحالة ← حدث `status_changed` واحد؛ PATCH يغيّر الموعد فقط لأمر مجدول ← حدث `updated` واحد؛ PATCH يغيّر الوصف فقط ← لا حدث؛ `business` و`external_ref` موجودان في بيانات الحدثين.

## ما يجب عدم تغييره
- شكل `work_order.created` و`work_order.status_changed` وأسماء حقولهما.
- سلوك إعادة المحاولة للأحداث القائمة (`work_order.status_changed` يبقى محاولة واحدة).
- منطق الحالات في `workorders.update` (الحالة «مجدول» تحتاج فنياً وموعداً معاً).
- إشعارات العميل والفني وخيار «إبلاغ العميل على واتساب».
- المسار الداخلي `/api/internal/v1` وكل ما يخص وكيل بانوراما.

## العلاقة بالمستودع الآخر
- الحدث: `work_order.updated` (جديد)، و`work_order.status_changed` (قائم، يُرسل الآن أيضاً عند الجدولة).
- الوجهة: اشتراك «بانوراما»، `POST https://commerce.tech-panorama.com/webhooks/aluminum`.
- المصادقة: `X-Aluminum-Signature: sha256=HMAC-SHA256(سر الاشتراك, الجسم)` كما هي. السر في بانوراما `INBOUND_WEBHOOK_SECRET`.
- شكل البيانات (الحقول التي تقرؤها بانوراما؛ بقية حقول أمر العمل تبقى كما هي):
```json
{
  "id": "0f6f1c1e-0000-4000-8000-000000000000",
  "event": "work_order.updated",
  "created_at": "2026-11-28T10:05:00.000Z",
  "data": {
    "id": 6,
    "number": "WO-2026-0006",
    "status": "scheduled",
    "scheduled_date": "2026-11-30",
    "scheduled_time": "10:00",
    "completed_at": null,
    "business": "panorama",
    "external_ref": "panorama:install:3"
  }
}
```
- بانوراما تتجاهل اليوم أي حدث لا تعرفه، فلا ضرر من إرساله قبل تنفيذ مهمتها. المالك يضيف `work_order.updated` إلى اشتراك «بانوراما» بعد النشر.

## معايير القبول
- [ ] جدولة أمر عمل من نافذة «تعديل / جدولة» (فني + موعد) ترسل `work_order.status_changed` بالحالة `scheduled`
- [ ] تغيير موعد أمر مجدول يرسل `work_order.updated` مرة واحدة
- [ ] لا حدث عند تعديل لا يمس الحالة أو الموعد أو الفني
- [ ] نتيجة المراجعة الشاملة مذكورة في وصف الـ PR
- [ ] الاختبارات تنجح
- [ ] تحديث `docs/STATUS.md` (قائمة الأحداث، وسطر في آخر التغييرات)
- [ ] Pull Request على الفرع المقترح (لا push مباشر إلى main)
