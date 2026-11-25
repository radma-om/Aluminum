# مهمة: مسار داخلي لبانوراما (العملاء وأوامر العمل) وإعادة محاولة Webhooks الجديدة

**المستودع:** `radma-om/Aluminum`
**الفرع المقترح:** `feature/internal-api-v1`
**التاريخ:** 2026-11-25
**مهام مرتبطة في المستودع الآخر:** `panorama-commerce` — «أساس نظام بانوراما وعميل Aluminum» (تُكتب بعد دمج هذه المهمة). **هذه المهمة تُنفَّذ أولاً.**
**المرجع:** «عقد الربط» المعتمد (2026-11-25)، الأقسام 2 و3 و4.3 و5.6 و5.7.

## الهدف
فنيو ردما يركّبون أيضاً كاميرات بانوراما، وسجل العملاء موحد في ردما. لذلك يحتاج نظام بانوراما أن ينشئ أو يحدّث العميل وأن ينشئ أمر عمل تركيب في ردما، بمسار داخلي آمن بصلاحيات محدودة لا يعتمد على `ADMIN_TOKEN`. وتُجهَّز معه آلية إعادة محاولة للحدثين الجديدين `lead.message` و`handoff.requested`.

## الوضع الحالي
- لا يوجد مسار داخلي لنظام خارجي (`docs/STATUS.md`). الحماية المتاحة: `ADMIN_TOKEN` أو جلسة موظف.
- `work_orders`: الحالات `new, scheduled, in_progress, done, cancelled`، والإنشاء عبر `workorders.create(db, input, author, { source, notify })` (`src/workorders.js:105`).
- `customers`: الرقم فريد، والمساعد `customers.normalizePhone` و`customers.ensure` (`src/customers.js:17`، `:24`).
- `webhooks.emit` يرسل صف أمر العمل كاملاً في `data` لحدثي `work_order.created` و`work_order.status_changed` (`src/server.js:1505`، `:1605`، `:1869`، `:1925`، `:1957`). الإرسال محاولة واحدة بمهلة 10 ث (`src/webhooks.js`).
- الترحيلات بنمط `addColumns(table, defs)` في `src/db.js:703`، والتنظيف في `pruneOldLogs` (`src/server.js:460`).

## المطلوب

### 1. وحدة جديدة `src/internal-api.js` ومسار `/api/internal/v1`
- تُركَّب **قبل** `app.use('/api/admin', admin)` (`src/server.js:2843`) وخارجه.
- **معطّلة بالكامل** إذا لم يُضبط `INTERNAL_API_KEY` و`INTERNAL_API_HMAC_SECRET`: كل الطلبات ترد `503` بـ `{"status":"unavailable"}`.
- **المصادقة** (كل الطلبات):
  - `Authorization: Bearer <INTERNAL_API_KEY>`، مقارنة ثابتة الزمن.
  - `X-Timestamp`: ثوانٍ Unix، يُرفض فرق أكثر من 300 ث.
  - `X-Request-Id`: UUID، يُرفض إذا تكرر خلال 24 ساعة.
  - `X-Signature: sha256=<hex>` = HMAC-SHA256 بالسر `INTERNAL_API_HMAC_SECRET` للنص `<X-Timestamp>.<X-Request-Id>.<الجسم الخام>`. يلزم قراءة الجسم الخام قبل تحليل JSON.
  - أي فشل → `401` بـ `{"status":"forbidden"}` دون تفاصيل.
- **Idempotency:** `Idempotency-Key` إلزامي لطلبات `POST`. نفس المفتاح على نفس المسار خلال 24 ساعة يعيد الرد المحفوظ نفسه دون تنفيذ ثانٍ.
- جدول جديد `internal_requests` (`request_id` PK، `idempotency_key`، `endpoint`، `status_code`، `response_json`، `created_at`)، ويُضاف إلى `pruneOldLogs` بحذف ما مضى عليه يومان.
- حد طلبات: 60 طلباً في الدقيقة لهذا المسار.
- تسجيل كل طلب في `audit_log` بالمستخدم `panorama` (بلا أي أسرار).
- قيم `status` في الرد: `ok` · `invalid_arguments` (422) · `not_found` (404) · `forbidden` (401) · `unavailable` (503) · `error` (500).

### 2. `POST /api/internal/v1/customers/upsert`
- المدخلات: `phone` (إلزامي)، `name`، `email`، `wilaya`، `address`، `map_url`، `source` (`panorama`)، `external_ref`.
- المطابقة بـ `customers.normalizePhone(phone)`. إن لم يوجد يُنشأ، وإن وُجد تُحدَّث الحقول المرسلة غير الفارغة فقط، ولا يُمسح أي حقل موجود.
- `wilaya` يُحفظ في `city`.
- جدول جديد `customer_external_refs` (`customer_id`، `system`، `ref`، فريد على `system, ref`) لحفظ `external_ref`.

### 3. `POST /api/internal/v1/work-orders`
- المدخلات الإلزامية: `customer_phone`، `business` (القيمة المسموحة حالياً `panorama` فقط)، `external_ref`، `title`، `items` (مصفوفة `{description, qty}`)، `approved_by`. الاختيارية: `customer_name`، `location` (`map_url`، `wilaya`، `address`)، `preferred_date` (YYYY-MM-DD)، `notes`.
- يُنشأ العميل أو يُحدَّث أولاً بنفس منطق البند 2.
- `workorders.create` بـ `kind='installation'` وحالة `new`، و`description` = `title` ثم سطر لكل بند (`qty × description`) ثم `notes`، و`location` = `wilaya`، و`created_by` = `panorama: <approved_by>`.
- **لا يُرسل أي إشعار للعميل عند الإنشاء**، ويحدد مكتب ردما الموعد والفني كالمعتاد. يُستدعى `fieldtrack.orderPlace` كما في المسار الإداري.
- `preferred_date` يُضاف كسطر في الوصف («الموعد المفضل لدى العميل: …») ولا يُعتبر موعداً مجدولاً.
- يُطلق الحدث القائم `work_order.created`.
- **منع التكرار:** إذا وُجد أمر بنفس `business` و`external_ref` يُعاد الأمر الموجود مع `"duplicate": true` دون إنشاء جديد.

### 4. `GET /api/internal/v1/work-orders/by-ref/:external_ref?business=panorama`
- يعيد: `work_order_id`، `number`، `status`، `scheduled_date`، `scheduled_time`، `completed_at`. لا يعيد بيانات الفني الشخصية ولا ملاحظات المكتب.

### 5. حقلان جديدان في `work_orders`
- `business TEXT NOT NULL DEFAULT 'radma'` و`external_ref TEXT`، بترحيل `addColumns`، وفهرس فريد على `(business, external_ref)` حين يكون `external_ref` غير فارغ.
- يظهر الحقلان تلقائياً في `data` لحدثي `work_order.created` و`work_order.status_changed` لأن الحدث يرسل صف الأمر. تحقّق من ذلك باختبار، ومن أن `workorders.get` يعيدهما.
- لا تغيير على أي حقل قائم في الحدثين.

### 6. إعادة المحاولة للحدثين الجديدين فقط
- أضف `lead.message` و`handoff.requested` إلى `EVENTS` في `src/webhooks.js`. **لا تُطلقهما من أي مكان في هذه المهمة**؛ إطلاقهما في مهمة لاحقة (ربط الوكيل).
- قائمة `RETRY_EVENTS = ['lead.message', 'handoff.requested']`. عند فشل إرسال أحدهما يُحفظ في جدول جديد `webhook_retries` (`id`، `webhook_id`، `event`، `payload`، `attempt`، `next_at`، `last_error`، `created_at`).
- مواعيد الإعادة: بعد 1 ثم 5 ثم 15 دقيقة، ثم يتوقف ويُسجَّل `alerts.fail`. يُعاد **نفس الـ payload بنفس `id`**.
- مؤقت كل دقيقة داخل العملية، والحالة كلها في الجدول حتى تستمر بعد إعادة التشغيل. يُضاف الجدول إلى `pruneOldLogs` (7 أيام).
- الأحداث القائمة تبقى محاولة واحدة كما هي اليوم.

### 7. التوثيق
- `.env.example`: `INTERNAL_API_KEY=` و`INTERNAL_API_HMAC_SECRET=` بلا قيم، مع تعليق قصير.
- `README.md`: قسم «المسار الداخلي لبانوراما» بالمسارات والترويسات وأمثلة الطلب والرد.
- `docs/STATUS.md`: «ما يتيحه النظام للربط» + «آخر التغييرات» + الحدثان الجديدان (مسجلان، غير مُطلقين بعد).

## ما يجب عدم تغييره
- شكل أي endpoint قائم أو أي حقل قائم في أحداث الـ Webhooks.
- `makeRequireAdmin` و`ADMIN_TOKEN` وصلاحيات الموظفين، فالمسار الجديد مستقل عنها تماماً.
- سلوك الإرسال الحالي لكل الأحداث القائمة.
- إشعارات أوامر العمل للعميل (`MAZBOT_WO_*`): تعمل كما هي عندما يجدول المكتب الأمر.
- لا يقرأ المسار الجديد أو يعيد أي أسعار أو فواتير أو تكاليف.

## العلاقة بالمستودع الآخر
**المسار الأساسي:** `https://calc.radma.co/api/internal/v1`

**الترويسات من بانوراما:**
```
Authorization: Bearer <ALUMINUM_API_KEY>          (= INTERNAL_API_KEY هنا)
X-Timestamp: 1764068400
X-Request-Id: 6f1c2a9e-0b7d-4c3e-9a51-2f8e7d4b1c10
X-Signature: sha256=<HMAC-SHA256(ALUMINUM_HMAC_SECRET, "1764068400.6f1c2a9e-....<body>")>
Idempotency-Key: panorama:install:1021:create
Content-Type: application/json
```

**`POST /customers/upsert`**
```json
{ "phone": "9689XXXXXXX", "name": "...", "email": null, "wilaya": "نزوى", "address": null, "map_url": null, "source": "panorama", "external_ref": "panorama:customer:45" }
```
```json
{ "status": "ok", "customer_id": 812, "created": false }
```

**`POST /work-orders`**
```json
{
  "customer_phone": "9689XXXXXXX",
  "customer_name": "...",
  "business": "panorama",
  "external_ref": "panorama:install:1021",
  "title": "تركيب 8 كاميرات + NVR",
  "items": [ { "description": "كاميرا IP 4MP خارجية", "qty": 8 }, { "description": "NVR 8 قنوات + HDD 2TB", "qty": 1 } ],
  "location": { "map_url": "https://maps.google.com/...", "wilaya": "نزوى", "address": "..." },
  "preferred_date": "2026-12-02",
  "notes": "التمديدات موجودة",
  "approved_by": "اسم مسؤول المبيعات"
}
```
```json
{ "status": "ok", "work_order_id": 3301, "number": "WO-2026-0153", "duplicate": false }
```

**`GET /work-orders/by-ref/panorama:install:1021?business=panorama`**
```json
{ "status": "ok", "work_order_id": 3301, "number": "WO-2026-0153", "order_status": "scheduled", "scheduled_date": "2026-12-03", "scheduled_time": "09:00", "completed_at": null }
```

**الحدث القائم بعد الإضافة** (`work_order.status_changed`): نفس الغلاف والحقول الحالية، ويُضاف داخل `data`:
```json
{ "business": "panorama", "external_ref": "panorama:install:1021" }
```

**المصادقة:** Bearer + HMAC كما سبق. متغيرات البيئة في Aluminum: `INTERNAL_API_KEY`، `INTERNAL_API_HMAC_SECRET`. وفي بانوراما: `ALUMINUM_BASE_URL`، `ALUMINUM_API_KEY`، `ALUMINUM_HMAC_SECRET`.

## معايير القبول
- [ ] بدون المتغيرين: كل `/api/internal/v1/*` ترد 503، ولا يتغير أي سلوك آخر.
- [ ] مفتاح خاطئ، توقيع خاطئ، توقيت أقدم من 300 ث، أو `X-Request-Id` مكرر → 401.
- [ ] نفس `Idempotency-Key` مرتين → نفس الرد، وأمر عمل واحد فقط.
- [ ] `upsert` لا يمسح حقلاً موجوداً بقيمة فارغة، ويطابق الأرقام بصيغها المختلفة (مع 968 وبدونها).
- [ ] `work-orders` بنفس `external_ref` مرتين → `duplicate: true` وأمر واحد.
- [ ] إنشاء أمر من بانوراما لا يرسل أي رسالة للعميل.
- [ ] `business` و`external_ref` يظهران في `data` لحدثي `work_order.created` و`work_order.status_changed`، وكل الحقول القديمة كما هي (اختبار يقارن المفاتيح).
- [ ] الطلب بـ `ADMIN_TOKEN` على المسار الداخلي يُرفض، ومفتاح المسار الداخلي على `/api/admin` يُرفض.
- [ ] فشل إرسال `lead.message` يُعاد بعد 1 و5 و15 دقيقة بنفس `id`، ويستمر بعد إعادة التشغيل؛ وفشل حدث قائم لا يُعاد.
- [ ] لا يظهر أي سر في السجلات أو الردود.
- [ ] الاختبارات تنجح (الحالية 319 + الجديدة)
- [ ] تحديث `docs/STATUS.md`
- [ ] Pull Request على الفرع المقترح (لا push مباشر إلى main)
