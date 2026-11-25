# حالة المستودع — نظام ردما للبوابات (Aluminum)

> هذا الملف تقرؤه محادثة التخطيط "المتجر الإلكتروني" لتعرف وضع النظام دون قراءة الكود كله.
> تحدّثه جلسة Claude Code الخاصة بهذا المستودع في نهاية كل مهمة.

**آخر تحديث:** 2026-11-25
**الإصدار:** 3.59.1
**الإنتاج:** `https://calc.radma.co` (Hostinger Business، نشر تلقائي من `main`)

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
- **لا يوجد مسار داخلي مخصص لنظام خارجي** (مفتاح خاص بصلاحيات محدودة). أي ربط يستدعي ردما من الخارج سيحتاج إضافة مسار جديد (مثل `/api/internal/*`) بمصادقة مستقلة.

### أحداث Webhooks
`quote.created` · `quote.status_changed` · `invoice.created` · `invoice.updated` · `invoice.cancelled` · `payment.created` · `work_order.created` · `work_order.status_changed` · `product.created` · `product.updated` · `product.deleted` · `purchase.created` · `settings.updated` · `database.restored` · `webhook.test`

كل طلب يحمل الترويسة `X-Aluminum-Event`، ومع المفتاح السري `X-Aluminum-Signature: sha256=<HMAC>`. تُقبل فقط روابط عامة على الإنترنت.

## الربط مع متجر بانوراما (WooCommerce)
- **الحالة:** لم يبدأ التنفيذ بعد. لا توجد endpoints أو حقول خاصة بالمتجر حتى الآن.
- **المتفق عليه:** —

## آخر التغييرات
| التاريخ | التغيير | PR |
|---|---|---|
| 2026-11-25 | إضافة `CLAUDE.md` و`docs/STATUS.md` | #204 |
| 2026-11-23 | 3.59.1: قراءة المواقع من روابط خرائط Google كما تشاركها الجوالات | #203 |
| 2026-11-23 | 3.59.0: الوقت والمسافة المتبقيان لوصول الفني (Google Routes) | #201 |
| 2026-11-23 | 3.58.0: «تتبع الفريق» على خرائط Google، ودور «مسوق» مع زيارات العملاء | #199 |
| 2026-11-23 | 3.57.0: تقويم المناسبات، وتاريخ بداية للعروض | #197 |

## قيد العمل / معلّق
- تأكيد نطاق الإنتاج من المالك: هذا الملف و`CLAUDE.md` يذكران `calc.radma.co`، بينما مثال `public_base_url` في الكود يذكر `calcshutter.radma.co` (`src/db.js`).
