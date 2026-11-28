# حالة المستودع — نظام ردما للبوابات (Aluminum)

> هذا الملف تقرؤه محادثة التخطيط "المتجر الإلكتروني" لتعرف وضع النظام دون قراءة الكود كله.
> تحدّثه جلسة Claude Code الخاصة بهذا المستودع في نهاية كل مهمة.

**آخر تحديث:** 2026-11-25
**الإصدار:** 3.61.0
**الإنتاج:** `https://calcshutter.radma.co` (Hostinger Business، نشر تلقائي من `main`)

## نظرة عامة
نظام تسعير شرائح الألمنيوم والإكسسوارات والمكائن: حاسبات العملاء (بوابة الشتر، الأوفرهيد، المكائن، المستلزمات)، لوحة إدارة، عروض أسعار وفواتير ومدفوعات، أوامر عمل لفريق التركيب، سجل عملاء، ومساعد ذكي على واتساب (MazBot) وفي موقع radma.co.

## ما يتيحه النظام للربط

### واجهات عامة (بدون مصادقة)
| المسار | الوظيفة |
|---|---|
| `GET /api/public/catalog` | كتالوج المستلزمات (شرائح وإكسسوارات) |
| `POST /api/public/quotes` | طلب مستلزمات |
| `GET /api/public/configurator` | خيارات حاسبة بوابة الشتر |
| `POST /api/public/door-price` / `POST /api/public/door-quotes` | سعر بوابة الشتر / طلب عرض |
| `GET /api/public/overhead` / `POST /api/public/overhead-price` / `POST /api/public/overhead-quotes` | حاسبة الأوفرهيد |
| `GET /api/public/motors` / `POST /api/public/motor-quotes` | المكائن |

### واجهات إدارية (`Authorization: Bearer <ADMIN_TOKEN>` أو توكن جلسة موظف)
`/api/admin/products` · `/api/admin/settings` · `/api/admin/quotes` · `/api/admin/configurator` · `/api/admin/webhooks` وغيرها (القائمة الكاملة في `README.md` ← «واجهة API باختصار»).

- **جديد (3.62.0):** `/api/admin/whatsapp-forms` (طلبات نموذج واتساب: القائمة، والحدث الخام، وإعادة المعالجة، والحالة)، ويستقبل webhook حساب القوالب من MazBot الحدث `whatsapp_form.submitted`. لا تغيير في المسارات القائمة.
- `ADMIN_TOKEN` صلاحية المالك الكاملة، ويمكن إيقاف الدخول به بـ `ADMIN_TOKEN_LOGIN=off` (عند وجود مدير بالتحقق بخطوتين). توكن الموظف من `POST /api/auth/login` صالح 14 يوماً وبصلاحيات أقسامه.

### المسار الداخلي لبانوراما (`/api/internal/v1`) — مستقل عن `ADMIN_TOKEN`
- **التفعيل:** موقوف (`503`) حتى يُضبط `INTERNAL_API_KEY` و`INTERNAL_API_HMAC_SECRET`. وفي بانوراما: `ALUMINUM_BASE_URL` و`ALUMINUM_API_KEY` و`ALUMINUM_HMAC_SECRET`.
- **المصادقة:** `Authorization: Bearer` + `X-Timestamp` (±300 ث) + `X-Request-Id` (UUID، لا يتكرر خلال 24 ساعة) + `X-Signature: sha256=HMAC("<ts>.<request-id>.<body>")`. أي فشل → `401 {"status":"forbidden"}`.
- **تكرار الطلب:** `Idempotency-Key` إلزامي لكل `POST`، ونفس المفتاح خلال 24 ساعة يعيد الرد نفسه. الحد 60 طلباً في الدقيقة (`429 {"status":"rate_limited"}`).
- **قيم `status`:** `ok` · `invalid_arguments` (422، مع `field`) · `not_found` (404) · `forbidden` (401) · `unavailable` (503) · `rate_limited` (429) · `error` (500).

| المسار | الوظيفة |
|---|---|
| `POST /customers/upsert` | إنشاء العميل أو تحديث الحقول غير الفارغة (لا يُمسح أي حقل)؛ `external_ref` يُحفظ. يرد `{status, customer_id, created}` |
| `POST /work-orders` | أمر تركيب «جديد» بلا إشعار للعميل؛ `business=panorama` فقط؛ نفس `external_ref` مرة ثانية يعيد `duplicate: true`. يرد `{status, work_order_id, number, duplicate}` |
| `GET /work-orders/by-ref/:external_ref?business=panorama` | `{status, work_order_id, number, order_status, scheduled_date, scheduled_time, completed_at}`؛ حالة الأمر في `order_status` |

التفاصيل والأمثلة في `README.md` ← «المسار الداخلي لبانوراما».

### أحداث Webhooks
`quote.created` · `quote.status_changed` · `invoice.created` · `invoice.updated` · `invoice.cancelled` · `payment.created` · `work_order.created` · `work_order.status_changed` · `work_order.updated` · `product.created` · `product.updated` · `product.deleted` · `purchase.created` · `settings.updated` · `database.restored` · `webhook.test`

- **جديد في `work_order.created` و`work_order.status_changed`:** داخل `data` حقلان إضافيان، `business` (`radma` أو `panorama`) و`external_ref`. كل الحقول القديمة كما هي.
- **`work_order.updated` (جديد، 3.65.0):** من نافذة «تعديل / جدولة» حين تبقى الحالة كما هي ويتغير الموعد أو الفني. البيانات كائن أمر العمل بنفس شكل `work_order.status_changed`، ومعها `business` و`external_ref`. يُعاد بعد 1 ثم 5 ثم 15 دقيقة. وتغيير الحالة من هذه النافذة (مثل الجدولة) يرسل الآن `work_order.status_changed`، لا الحدثين معاً.
- **`lead.message` و`handoff.requested` يُطلقان في الوضع `PANORAMA_TOOLS_ENABLED=1` فقط** (3.63.0): `lead.message` بعد كل رد على رسالة بانوراما أو مختلطة، و`handoff.requested` عند التحويل لفريق بانوراما. الشكل في `README.md` ← «ربط وكيل بانوراما».
  - عند فشل الإرسال يُعادان بعد 1 ثم 5 ثم 15 دقيقة، بنفس الـ payload ونفس `id`.
  - الأحداث الأخرى محاولة واحدة.
  - الاشتراك بـ «كل الأحداث» (`*`) سيستقبلهما عند إطلاقهما.

كل طلب يحمل الترويسة `X-Aluminum-Event`، ومع المفتاح السري `X-Aluminum-Signature: sha256=<HMAC>`. تُقبل فقط روابط عامة على الإنترنت.

### ما يستدعيه وكيل ردما من بانوراما (3.63.0)
- `GET /api/internal/v1/tools` و`POST /api/internal/v1/tools/execute` على `PANORAMA_BASE_URL`، موقّعة بـ `PANORAMA_API_KEY` و`PANORAMA_HMAC_SECRET`.
- المتغيرات: `PANORAMA_TOOLS_ENABLED` (`0`/`shadow`/`1`)، `PANORAMA_BASE_URL`، `PANORAMA_API_KEY`، `PANORAMA_HMAC_SECRET`، `PANORAMA_TOOL_TIMEOUT_MS`، و`PANORAMA_WRITE_API_KEY` (اختياري، 3.64.0). وإعداد `panorama_recipients` في اللوحة.
- **أدوات الكتابة (3.64.0):** `panorama_request_installation` و`panorama_create_quote` بمفتاح الكتابة، و`Idempotency-Key` ثابت لكل استدعاء، وإعادة واحدة عند انقطاع الشبكة أو انتهاء المهلة فقط. على واتساب فقط، و`customer_consent: true` فقط مع `customer_confirmed: true`. لا تُرسل في `shadow`.

## الربط مع متجر بانوراما (WooCommerce)
- **الحالة:** المسار الداخلي v1 **مفعّل في الإنتاج** (العملاء وأوامر العمل)، وحقلا `business`/`external_ref` في أوامر العمل، وإعادة المحاولة للحدثين الجديدين. التالي في بانوراما: «أساس نظام بانوراما وعميل Aluminum».
- **التفعيل (2026-11-25):**
  - في ردما: `INTERNAL_API_KEY` و`INTERNAL_API_HMAC_SECRET`.
  - في بانوراما: `ALUMINUM_BASE_URL=https://calcshutter.radma.co/api/internal/v1` و`ALUMINUM_API_KEY` و`ALUMINUM_HMAC_SECRET`، بالقيمتين نفسيهما.
- **الاختبار:**
  - طلب بلا توقيع رُدّ بـ `401 forbidden`.
  - طلب موقّع من جهاز المالك (`GET /work-orders/by-ref/panorama:test:0?business=panorama`) رُدّ بـ `404 not_found`، أي أن المصادقة والتوقيع يعملان.
  - لم يُختبر بعد طلب من كود بانوراما نفسه.
- **المتفق عليه:** «عقد الربط» (2026-11-25)، الأقسام 2 و3 و4.3 و5.6 و5.7. المهمة: `docs/tasks/2026-11-25-internal-api-v1.md`.

## آخر التغييرات
| التاريخ | التغيير | PR |
|---|---|---|
| 2026-11-28 | 3.65.0: الجدولة من نافذة «تعديل / جدولة» ترسل `work_order.status_changed`، وحدث جديد `work_order.updated` لتغيير الموعد أو الفني. وصار الحدث يُرسل أيضاً لزيارة الخدمة في الموقع (`created` ثم `status_changed`) ولأوامر الفواتير الملغاة سابقاً عند بدء التشغيل | #226 |
| 2026-11-28 | 3.64.0: أدوات الكتابة من بانوراما (طلب تركيب، عرض سعر) بموافقة العميل على واتساب فقط، مع `Idempotency-Key` ومتغير `PANORAMA_WRITE_API_KEY`. وإصلاح اختبار تقييم كان مرتبطاً بتاريخ ثابت. لا تغيير في أي endpoint أو حدث قائم | #224 |
| 2026-11-26 | 3.63.1: إصلاح فشل كل إرسال Webhook على Node 22 (`Invalid IP address: undefined`) — دالة `lookup` المثبّتة تخدم الشكلين `{ all: true }` والمفرد. لا تغيير في شكل الأحداث ولا في حماية SSRF | #222 |
| 2026-11-26 | 3.63.0: ربط وكيل ردما بأدوات بانوراما (الأوضاع `0`/`shadow`/`1`، التوجيه، قاطع الدائرة، الردود التجريبية، بطاقة «بانوراما»)، وإطلاق `lead.message`/`handoff.requested` في الوضع `1`. لا تغيير في أي endpoint أو شكل حدث قائم | #220 |
| 2026-11-26 | 3.63.0 (تصحيح قبل الدمج): رسالة بلا موضوع في محادثة جديدة (مثل التحية) لا تُطلق `lead.message` ولا تشغّل الرد التجريبي؛ وتبقى ترى أدوات النشاطين | #220 |
| 2026-11-26 | 3.62.2: نموذج واتساب — قراءة «ارتفاع الفتحة» وتعبئته في «تسعير الآن» | #218 |
| 2026-11-26 | 3.62.1: قراءة إجابات نموذج واتساب بشكلها الفعلي من MazBot (`{label, value}` تحت معرّف كل حقل)، ومطابقة الولاية المكتوبة بالإنجليزية | #216 |
| 2026-11-26 | 3.62.0: استقبال نموذج واتساب «طلب عرض سعر» (`whatsapp_form.submitted` على webhook حساب القوالب) وبطاقة «طلبات نموذج واتساب». لا تغيير في أي endpoint أو Webhook قائم | #214 |
| 2026-11-26 | 3.61.0: تذكير عملاء «متابعة العملاء» بلا عرض سعر (قالب جديد `MAZBOT_LEAD_REMINDER_TEMPLATE_ID`). لا تغيير في أي endpoint أو Webhook قائم | #212 |
| 2026-11-25 | المسار الداخلي مفعّل في الإنتاج، ونجح اختبار طلب موقّع (توثيق فقط) | #210 |
| 2026-11-25 | تصحيح نطاق الإنتاج في التوثيق إلى `calcshutter.radma.co` (`CLAUDE.md` و`docs/STATUS.md` وقسم Hostinger في `README.md`) | #208 |
| 2026-11-25 | 3.60.0: المسار الداخلي لبانوراما `/api/internal/v1` (العملاء وأوامر العمل)، حقلا `business`/`external_ref`، والحدثان `lead.message`/`handoff.requested` مع إعادة المحاولة | #206 |
| 2026-11-25 | إضافة `CLAUDE.md` و`docs/STATUS.md` | #204 |
| 2026-11-23 | 3.59.1: قراءة المواقع من روابط خرائط Google كما تشاركها الجوالات | #203 |
| 2026-11-23 | 3.59.0: الوقت والمسافة المتبقيان لوصول الفني (Google Routes) | #201 |
| 2026-11-23 | 3.58.0: «تتبع الفريق» على خرائط Google، ودور «مسوق» مع زيارات العملاء | #199 |
| 2026-11-23 | 3.57.0: تقويم المناسبات، وتاريخ بداية للعروض | #197 |

## قيد العمل / معلّق
- اختبار الاتصال من كود بانوراما نفسه (مثل زر «اختبار الاتصال بردما»)، والتأكد أن `ALUMINUM_API_KEY` في بانوراما طوله 64 حرفاً بلا أي جزء زائد.
- أضف `work_order.updated` إلى اشتراك «بانوراما» في «الربط» ← Webhooks (بعد نشر 3.65.0).
- أدوات الكتابة: بعد دمج مهمة بانوراما «تسعير التركيب وطلبات التركيب وعروض الأسعار»، اضبط `PANORAMA_WRITE_API_KEY` (= `INTERNAL_WRITE_API_KEY`)، ثم «اختبار الاتصال» (يجب أن تظهر أداتا كتابة)، وجرّبها بالوضع `shadow` أولاً.
- تفعيل ربط الوكيل في الإنتاج: ضبط متغيرات `PANORAMA_*` بالوضع `shadow`، ثم «اختبار الاتصال»، ومراجعة الردود التجريبية بعد نشر منتجات بانوراما، ثم الاشتراك في الحدثين بعنوان `https://commerce.tech-panorama.com/webhooks/aluminum` والانتقال إلى `1`.
- نموذج واتساب: بعد نشر 3.62.1 اضغط «إعادة المعالجة» على أول طلب حقيقي وتأكد أن «لم يُفهم» فارغ.
