# مهمة: إصلاح فشل إرسال Webhooks في ردما (Aluminum)

## المستودع
`radma-om/Aluminum` (فرع `main`)، وهو التطبيق المنشور على `calcshutter.radma.co` (Hostinger Node.js، والإصدار Node 22.23.5).

## المشكلة
كل إرسال Webhook من ردما يفشل قبل أن يخرج من الخادم، وهذه رسالة الخطأ:

```
Invalid IP address: undefined
```

ظهرت الرسالة عند الضغط على «اختبار» في لوحة ردما ← الربط ← Webhooks، على الـ Webhook المضاف إلى بانوراما:
`https://commerce.tech-panorama.com/webhooks/aluminum`
ولم يصل أي حدث إلى بانوراما.

## السبب
في `src/webhooks.js` داخل الدالة `postPinned` توجد دالة `lookup` مخصصة، وظيفتها تثبيت العنوان الذي اجتاز فحص `safe-url.js` حتى لا يُعاد توجيه الدومين إلى عنوان داخلي (DNS rebinding):

```js
lookup: (_hostname, _options, callback) => callback(null, address, net.isIP(address)),
```

في Node 20 وما بعده (بسبب `autoSelectFamily`) تُستدعى `lookup` بالخيار `{ all: true }`، وينتظر Node عندها **مصفوفة** من `{ address, family }`. الدالة الحالية ترد بعنوان مفرد، فيفشل الاتصال بالرسالة السابقة. النتيجة أن كل الأحداث تفشل، ومنها `lead.message` و`handoff.requested`، وليس الاختبار فقط.

## المطلوب
1. في `src/webhooks.js` استبدل سطر `lookup` السابق بهذا الكود:

```js
            /* Node 20+ (autoSelectFamily) calls lookup with { all: true } and then expects
               an array of { address, family }; answering with a bare string makes the
               socket fail with "Invalid IP address: undefined". Serve both call shapes. */
            lookup: (_hostname, options, callback) => {
                if (typeof options === 'function') { callback = options; options = {}; }
                const family = net.isIP(address);
                if (options && options.all) callback(null, [{ address, family }]);
                else callback(null, address, family);
            },
```

2. لا تغيّر أي شيء آخر. حماية SSRF (`resolvePublicUrl` والتثبيت على `addresses[0]` و`servername`) تبقى كما هي.
3. أضف اختباراً في مجلد `test/` يتحقق من أمرين:
   - استدعاء `lookup` مع `{ all: true }` يعيد مصفوفة `[{ address, family }]`.
   - استدعاؤها دون `all` يعيد `(address, family)`.
   وإن احتاج الاختبار إلى تصدير دالة مساعدة من `webhooks.js` فصدّرها دون أن تغيّر سلوك أي دالة.
4. شغّل `npm test`. قبل الإصلاح كانت النتيجة 342 اختباراً ناجحاً، فيجب أن تبقى كلها ناجحة، إضافة إلى الاختبار الجديد.
5. ابحث في المستودع عن أي `lookup:` مخصص آخر يعاني المشكلة نفسها: `grep -rn "lookup:" src/`. أصلحه بالطريقة نفسها إن وُجد.
6. اعمل commit واضحاً وارفعه إلى `main`، فالنشر في Hostinger يجري تلقائياً من `main`. إن كان المستودع يتطلب Pull Request فافتح PR.

## تحقق سريع (اختياري، يدوي)
على Node 22، الطلب الذي يستخدم دالة `lookup` القديمة يفشل بالرسالة `Invalid IP address: undefined`، والطلب الذي يستخدم الدالة الجديدة يصل إلى الخادم ويعيد رمز HTTP.

## بعد النشر
- تأكد أن رد `https://calcshutter.radma.co/healthz` هو `"ok":true`.
- يدوياً من اللوحة: ردما ← الربط ← Webhooks ← «اختبار» على Webhook بانوراما. المتوقع أن تنجح العملية، وأن يظهر في لوحة بانوراما (`/admin` ← «وكيل واتساب» ← أحداث ردما) الحدث `webhook.test` بنتيجة «test received».

## قيود
- لا تقرأ أي قيمة سرية ولا تطبعها ولا تغيّرها، سواء كانت متغيرات بيئة أو مفاتيح Webhooks.
- لا تغيّر متغيرات البيئة في Hostinger.
- لا تلمس مستودع بانوراما (`panorama-commerce`).
