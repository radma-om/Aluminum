# مهمة: السماح بأدوات الكتابة من بانوراما (طلب تركيب وعرض سعر) بموافقة العميل

**المستودع:** `radma-om/Aluminum`
**الفرع المقترح:** `feature/panorama-write-tools`
**التاريخ:** 2026-11-28
**مهام مرتبطة في المستودع الآخر:** `panorama-commerce` — «تسعير التركيب وطلبات التركيب وعروض الأسعار» (`2026-11-28-panorama-installation-quotes.md`). **تلك تُنفَّذ أولاً**، وهذه بعد دمجها.
**المرجع:** «عقد الربط» 1.3، الأقسام 3 و4.1 و9.2.

## الهدف
بانوراما أضاف أداتَي كتابة: `panorama_request_installation` و`panorama_create_quote`. ردما يتجاهل اليوم كل أداة نوعها `write`. المطلوب أن يستخدمهما الوكيل على واتساب فقط، وبعد موافقة العميل الصريحة، وبلا تكرار عند إعادة المحاولة.

## الوضع الحالي
- 3.63.x: `src/panorama-client.js` يقبل من `/tools` الأدوات التي تبدأ بـ `panorama_` ونوعها `read` فقط، ويعيد المحاولة مرتين عند فشل الشبكة.
- `context.customer_consent` يُرسل `false` دائماً.
- في الوضع `shadow` الأدوات المحلية الكاتبة تُنفَّذ كتجربة جافة (`dry_run`).

## المطلوب
1. **الإعداد:** متغير جديد `PANORAMA_WRITE_API_KEY` (= `INTERNAL_WRITE_API_KEY` في بانوراما). بدونه تبقى أدوات الكتابة متجاهَلة كما اليوم. التوقيع بنفس `PANORAMA_HMAC_SECRET`.
2. **قبول أدوات `write`** من `/tools` حين يكون المتغير مضبوطاً، بنفس شروط الاسم (`panorama_`).
   - `GET /tools` يُستدعى بمفتاح الكتابة إن وُجد (بانوراما يعرض أدوات الكتابة لحامل مفتاح الكتابة فقط)، وإلا بمفتاح القراءة.
   - استدعاء أداة `read` يبقى بمفتاح القراءة، وأداة `write` بمفتاح الكتابة.
3. **من يراها:** تُعرض للنموذج فقط حين `ctx.phone` موجود والقناة `mazbot` أو `whatsapp`. محادثة الموقع وتجربة الإدارة لا تريانها.
4. **الموافقة:**
   - `context.customer_consent = true` فقط إذا كانت `arguments.customer_confirmed === true`؛ وإلا `false`.
   - يُضاف لقسم تعليمات بانوراما: «أدوات التسجيل (طلب تركيب، عرض سعر): اعرض التفاصيل والسعر المبدئي أولاً، واسأل العميل صراحة، ولا تستدعِها مع customer_confirmed=true إلا بعد أن يوافق في رسالته. إذا عاد الرد needs_confirmation فاسأل العميل ولا تكرر الاستدعاء».
5. **منع التكرار:**
   - ترويسة `Idempotency-Key` لكل استدعاء `write`: UUID يُولَّد **مرة واحدة لاستدعاء الأداة** ويُعاد نفسه في إعادة المحاولة.
   - إعادة المحاولة لأداة `write` **فقط** عند انقطاع الشبكة أو انتهاء المهلة (مرة واحدة، بنفس المفتاح). لا إعادة عند أي رد HTTP.
6. **الوضع `shadow`:** أدوات الكتابة لا تُرسل لبانوراما، وتعيد للنموذج `{"status":"ok","dry_run":true}`.
7. **السجل:** `remote_tool_calls` يضيف العمود `kind` (`read`/`write`). بلا حجج ولا أرقام.
8. **بطاقة «بانوراما» في اللوحة:** تعرض هل مفتاح الكتابة مضبوط، وعدد أدوات القراءة والكتابة في «اختبار الاتصال».
9. `.env.example`، و`README.md`، و`docs/STATUS.md`.

## ما يجب عدم تغييره
- شكل أي endpoint أو حدث قائم.
- سلوك الوضع `0`، وأدوات ردما الـ 16 وتعليماتها.
- أدوات القراءة العشر وطريقة استدعائها.
- لا يُرسل سجل المحادثة لبانوراما.

## العلاقة بالمستودع الآخر
- **المسار:** `POST https://commerce.tech-panorama.com/api/internal/v1/tools/execute`
- **الترويسات لأداة كتابة:**
```
Authorization: Bearer <PANORAMA_WRITE_API_KEY>
X-Timestamp: <ثوانٍ>
X-Request-Id: <uuid جديد لكل طلب HTTP>
X-Signature: sha256=<HMAC(PANORAMA_HMAC_SECRET, "<ts>.<rid>.<body>")>
Idempotency-Key: <uuid ثابت لاستدعاء الأداة>
```
- **الجسم:**
```json
{
  "tool": "panorama_create_quote",
  "arguments": { "items": [ { "sku": "DS-2CD1043G2-LIU", "qty": 8 } ], "customer_name": "...", "customer_confirmed": true },
  "context": { "channel": "mazbot", "conversation_key": "mz:9689XXXXXXX", "customer_phone": "9689XXXXXXX", "customer_verified": true, "customer_consent": true }
}
```
- **الردود المحتملة** (دائماً 200 بعد المصادقة): `ok` · `needs_confirmation` · `forbidden` · `invalid_arguments` · `not_found` · `rate_limited` · `unavailable` · `error`، ويُعاد الرد للنموذج كما هو.
- **مثال `ok`:**
```json
{ "status": "ok", "as_of": "2026-11-28T10:00:00Z",
  "data": { "number": "PQ-2026-0001", "url": "https://commerce.tech-panorama.com/q/<token>", "total_omr": 229.000, "valid_until": "2026-12-05" },
  "message_for_agent": "أرسل رابط العرض للعميل" }
```

## معايير القبول
- [ ] بدون `PANORAMA_WRITE_API_KEY`: السلوك مطابق لما قبل المهمة (اختبار).
- [ ] أداة كتابة تُستدعى بمفتاح الكتابة ومعها `Idempotency-Key`، وأداة قراءة بمفتاح القراءة وبلا هذه الترويسة.
- [ ] إعادة المحاولة بعد انتهاء المهلة تحمل **نفس** `Idempotency-Key` و`X-Request-Id` جديداً، ولا إعادة عند رد HTTP.
- [ ] `customer_confirmed` غائب أو `false` → `customer_consent: false`.
- [ ] محادثة الموقع وتجربة الإدارة لا تريان أدوات الكتابة.
- [ ] `shadow`: لا طلب شبكة لأداة كتابة، والنموذج يستلم `dry_run`.
- [ ] الاختبارات تنجح
- [ ] تحديث `docs/STATUS.md`
- [ ] Pull Request على الفرع المقترح (لا push مباشر إلى main)
