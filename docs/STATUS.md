# حالة المستودع — نظام ردما للبوابات (Aluminum)

> هذا الملف تقرؤه محادثة التخطيط "المتجر الإلكتروني" لتعرف وضع النظام دون قراءة الكود كله.
> تحدّثه جلسة Claude Code الخاصة بهذا المستودع في نهاية كل مهمة.

**آخر تحديث:** 2026-11-25
**الإصدار:** 3.60.0
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
`quote.created` · `quote.status_changed` · `invoice.created` · `invoice.updated` · `invoice.cancelled` · `payment.created` · `work_order.created` · `work_order.status_changed` · `product.created` · `product.updated` · `product.deleted` · `purchase.created` · `settings.updated` · `database.restored` · `webhook.test`

- **جديد في `work_order.created` و`work_order.status_changed`:** داخل `data` حقلان إضافيان، `business` (`radma` أو `panorama`) و`external_ref`. كل الحقول القديمة كما هي.
- **حدثان مسجلان، لا يُطلقان بعد** (يُطلقان في مهمة ربط الوكيل): `lead.message` و`handoff.requested`.
  - عند فشل الإرسال يُعادان بعد 1 ثم 5 ثم 15 دقيقة، بنفس الـ payload ونفس `id`.
  - الأحداث الأخرى محاولة واحدة.
  - الاشتراك بـ «كل الأحداث» (`*`) سيستقبلهما عند إطلاقهما.

كل طلب يحمل الترويسة `X-Aluminum-Event`، ومع المفتاح السري `X-Aluminum-Signature: sha256=<HMAC>`. تُقبل فقط روابط عامة على الإنترنت.

## الربط مع متجر بانوراما (WooCommerce)
- **الحالة:** المسار الداخلي v1 جاهز في ردما (العملاء وأوامر العمل)، وحقلا `business`/`external_ref` في أوامر العمل، وإعادة المحاولة للحدثين الجديدين. التالي في بانوراما: «أساس نظام بانوراما وعميل Aluminum».
- **المتفق عليه:** «عقد الربط» (2026-11-25)، الأقسام 2 و3 و4.3 و5.6 و5.7. المهمة: `docs/tasks/2026-11-25-internal-api-v1.md`.

## آخر التغييرات
| التاريخ | التغيير | PR |
|---|---|---|
| 2026-11-25 | تصحيح نطاق الإنتاج في التوثيق إلى `calcshutter.radma.co` (`CLAUDE.md` و`docs/STATUS.md` وقسم Hostinger في `README.md`) | #208 |
| 2026-11-25 | 3.60.0: المسار الداخلي لبانوراما `/api/internal/v1` (العملاء وأوامر العمل)، حقلا `business`/`external_ref`، والحدثان `lead.message`/`handoff.requested` مع إعادة المحاولة | #206 |
| 2026-11-25 | إضافة `CLAUDE.md` و`docs/STATUS.md` | #204 |
| 2026-11-23 | 3.59.1: قراءة المواقع من روابط خرائط Google كما تشاركها الجوالات | #203 |
| 2026-11-23 | 3.59.0: الوقت والمسافة المتبقيان لوصول الفني (Google Routes) | #201 |
| 2026-11-23 | 3.58.0: «تتبع الفريق» على خرائط Google، ودور «مسوق» مع زيارات العملاء | #199 |
| 2026-11-23 | 3.57.0: تقويم المناسبات، وتاريخ بداية للعروض | #197 |

## قيد العمل / معلّق
- ضبط `INTERNAL_API_KEY` و`INTERNAL_API_HMAC_SECRET` في Hostinger (والقيمتان نفسهما في بانوراما) بعد الدمج.
- إطلاق `lead.message` و`handoff.requested` في مهمة ربط الوكيل.
