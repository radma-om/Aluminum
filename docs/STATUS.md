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

### واجهات إدارية (`Authorization: Bearer <ADMIN_TOKEN>`)
`/api/admin/products` · `/api/admin/settings` · `/api/admin/quotes` · `/api/admin/configurator` · `/api/admin/webhooks` وغيرها (القائمة الكاملة في `README.md` ← «واجهة API باختصار»).

### أحداث Webhooks
`quote.created` · `quote.status_changed` · `invoice.created` · `invoice.updated` · `invoice.cancelled` · `payment.created` · `work_order.created` · `work_order.status_changed` · `product.created` · `product.updated` · `product.deleted` · `purchase.created` · `settings.updated`

كل طلب يحمل الترويسة `X-Aluminum-Event`، ومع المفتاح السري `X-Aluminum-Signature: sha256=<HMAC>`. تُقبل فقط روابط عامة على الإنترنت.

## الربط مع متجر بانوراما (WooCommerce)
- **الحالة:** لم يبدأ التنفيذ بعد. لا توجد endpoints أو حقول خاصة بالمتجر حتى الآن.
- **المتفق عليه:** —

## آخر التغييرات
| التاريخ | التغيير | PR |
|---|---|---|
| 2026-11-23 | تطبيق المكتب الصناعي دون اتصال (offline) | #203 |

## قيد العمل / معلّق
- —
