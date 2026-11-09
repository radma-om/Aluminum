# Infocomm Verify API mapping

> الحالة: بانتظار التوثيق الرسمي من Infocomm. الميزة معطلة افتراضيًا ولا يجري الكود الحالي أي اتصال بالخدمة.

| العنصر | قيمة Infocomm الرسمية | موضعه في الكود |
|---|---|---|
| Base URL | بانتظار التوثيق | environment/config |
| Authentication header | بانتظار التوثيق | `provider-infocomm.js` |
| Request OTP endpoint | بانتظار التوثيق | `requestCode` |
| Verify OTP endpoint | بانتظار التوثيق | `verifyCode` |
| Delivery webhook | بانتظار التوثيق | `/webhooks/infocomm/verify` |
| Error codes | بانتظار التوثيق | provider mapping |
| Idempotency | بانتظار التوثيق | `requestCode` |

لا يجوز تغيير `mappingReady` إلى `true` قبل استلام الوثائق الرسمية واختبار الربط في staging. المزود الحالي يعيد `provider_not_configured` ولا يستدعي `fetch`.
