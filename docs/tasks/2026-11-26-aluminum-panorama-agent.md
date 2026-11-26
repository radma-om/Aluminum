# مهمة: ربط وكيل ردما بأدوات بانوراما (المرحلة 4)

**المستودع:** `radma-om/Aluminum`
**الفرع المقترح:** `feature/panorama-agent`
**التاريخ:** 2026-11-26
**مهام مرتبطة في المستودع الآخر:**
- `panorama-commerce`: «Tool API — أدوات القراءة»، **مدموجة** (PR #7، الإصدار 0.4.0). هذه المهمة تستدعيها.
- `panorama-commerce`: «استقبال أحداث ردما» (`2026-11-26-panorama-aluminum-webhooks.md`)، **مستقلة** ويمكن تنفيذها قبل هذه المهمة أو بعدها. الحدثان هنا لا يُرسلان إلا لمن اشترك فيهما من لوحة Webhooks.

**المرجع:** «عقد الربط» الإصدار 1.2، الأقسام 2 و3 و4.1 و4.2 و5.1–5.5 و6؛ و`ARCHITECTURE.md` §10.

## الهدف
عندما يسأل عميل على واتساب (90660002) أو في محادثة الموقع عن كاميرات أو شبكات أو انتركوم، يجيبه الوكيل نفسه بأسعار ومنتجات حقيقية من نظام بانوراما. يبقى سلوك ردما كما هو تماماً حين يكون الربط معطّلاً، وفي الوضع التجريبي يُكتب رد بانوراما للمراجعة فقط ولا يُرسل للعميل.

## الوضع الحالي
- **`src/agent.js`:**
  - `TOOLS` (16 أداة، و`strict: true`)، و`OPENAI_TOOLS` مشتقة منها.
  - `executeTool(name, input, ctx)` ينتهي بـ `default: throw`.
  - `runChat` يختار المزود، ثم `chatOpenAI`/`chatAnthropic` بحد `MAX_TOOL_ROUNDS = 8`.
  - `systemPrompt(settings, db)`.
- **مداخل الوكيل:**
  - `mazbot-inbox.js` (`agent.chat` بالمفتاح `mz:<phone>`، و`notifyHuman` يوقف الرد ويبلّغ `mazbot_recipients`)؛
  - `POST /api/public/chat` (`server.js:785`، بلا رقم)؛
  - `whatsapp.js:138`؛
  - `POST /api/admin/agent/chat` (تجربة الإدارة).
- `agent_conversations` (`conversation_key`، `channel`، `messages_json`، `updated_at`).
- `webhooks.js`: الحدثان `lead.message` و`handoff.requested` مسجلان بإعادة المحاولة (1، 5، 15 دقيقة) ولا يُطلقان بعد.
- لا يوجد عميل لنظام بانوراما.

## المطلوب

### 1. الإعدادات
| المتغير | الغرض |
|---|---|
| `PANORAMA_TOOLS_ENABLED` | `0` (الافتراضي): معطّل تماماً، وسلوك ردما كما هو اليوم · `shadow`: تجريبي، يُكتب رد بانوراما ولا يُرسل · `1`: مفعّل |
| `PANORAMA_BASE_URL` | `https://commerce.tech-panorama.com` **بلا** مسار، والعميل يضيف `/api/internal/v1` |
| `PANORAMA_API_KEY` و`PANORAMA_HMAC_SECRET` | بنفس قيمتي `INTERNAL_API_KEY` و`INTERNAL_API_HMAC_SECRET` في بانوراما |
| `PANORAMA_TOOL_TIMEOUT_MS` | الافتراضي 8000 |

- أي قيمة ناقصة مع `shadow` أو `1` → يتصرف كـ `0`، مع تنبيه `alerts.fail('panorama', …)`.

### 2. العميل `src/panorama-client.js`
- **التوقيع** (عقد الربط §4.1): `Authorization: Bearer`، `X-Timestamp`، `X-Request-Id` (UUID جديد لكل طلب)، `X-Signature: sha256=HMAC("<ts>.<rid>.<body>")`. ولطلب `GET` الجسم فارغ.
- `listTools()`: `GET /tools`.
  - تخزين مؤقت 10 دقائق في الذاكرة؛
  - مهلة 5 ثوانٍ؛
  - عند الفشل تُستخدم آخر نسخة ناجحة، فإن لم توجد → لا أدوات بانوراما.
  - تُقبل فقط الأدوات التي تبدأ بـ `panorama_` ونوعها `read`. أي أداة `write` تُتجاهل في هذه المهمة.
- `execute(tool, args, context)`: `POST /tools/execute` بالجسم `{tool, arguments, context}` (§5.2).
  - مهلة `PANORAMA_TOOL_TIMEOUT_MS`، وإعادة مرتين (0.5 ث ثم 1 ث) عند انقطاع الشبكة أو انتهاء المهلة أو رمز غير 200.
  - **401 لا يُعاد**، ويُسجَّل تنبيه «مفاتيح بانوراما غير صحيحة».
- **قاطع الدائرة:** 3 إخفاقات متتالية → إيقاف 60 ثانية. خلال الإيقاف يعيد مباشرة:
  ```json
  { "status": "unavailable", "data": null, "message_for_agent": "أسعار بانوراما غير متاحة الآن؛ لا تذكر أي سعر، واعرض تحويل العميل لموظف" }
  ```
- جدول جديد `remote_tool_calls` (`request_id`، `tool`، `status`، `duration_ms`، `channel`، `created_at`)، **بلا** حجج ولا أرقام هواتف. يُضاف إلى `pruneOldLogs` (30 يوماً).

### 3. التوجيه `src/router.js` (بلا نموذج إضافي، ARCHITECTURE §10.1)
`classify(text, state)` يعيد `RADMA` أو `PANORAMA` أو `MIXED` أو `NONE`:
- **PANORAMA:** نمط SKU (مثل `DS-` أو `IDS-` أو `DS-2CD…`)، أو كلمات: كاميرا/كاميرات/كاميرة، مراقبة، NVR، DVR، هارديسك، انتركوم، بصمة، حضور وانصراف، راوتر، سويتش، شبكة، واي فاي، أكسس بوينت، مكبر/سماعات، UPS، بانوراما.
- **RADMA:** شتر، رول، أوفرهيد، بوابة، باب كراج، مكينة/ماكينة/محرك بوابة، ريموت بوابة، مقاسات أو ارتفاع أو عرض مع أرقام، ألمنيوم، ردما.
- **MIXED:** كلمات من النشاطين في نفس الرسالة.
- **NONE:** لا تطابق، مثل التحية أو «كم السعر؟».

القواعد:
- التطبيع: بلا تشكيل، وتوحيد الأحرف (أ/إ/آ ← ا، ة/ه، ى/ي)، والأرقام العربية ← إنجليزية.
- **النشاط الحالي للمحادثة:** عمودان جديدان في `agent_conversations` بـ `addColumns`: `current_business TEXT` و`context_json TEXT`.
  - `NONE` يبقى على `current_business` إن وُجد. وإن لم يوجد → `MIXED`، فيرى النموذج النشاطين ويسأل العميل.
  - `RADMA` أو `PANORAMA` يحدّث `current_business`.
  - `resetConversation` يمسحهما.
- **ما يراه النموذج:**
  - `RADMA`: أدوات ردما الـ 16 فقط، **وبنفس الـ prompt الحالي حرفياً**.
  - `PANORAMA`: أدوات بانوراما + `request_human` فقط.
  - `MIXED`: الاثنان.

### 4. تعديلات `src/agent.js`
- **عند `PANORAMA_TOOLS_ENABLED=0`:** لا يُستدعى الـ router ولا العميل، و`TOOLS` و`systemPrompt` كما هي. اختبار يقارنها بنسخة ما قبل التعديل.
- **قائمة الأدوات تُبنى لكل جولة:** الأدوات المحلية المختارة، ثم أدوات بانوراما من `listTools()` محوّلة:
  - Anthropic: `{name, description, input_schema}` **بلا `strict`**؛
  - OpenAI: `{type: 'function', function: {name, description, parameters, strict: false}}`، لأن مخططات بانوراما فيها حقول اختيارية لا يقبلها الوضع الصارم.
- **`executeTool`:** قبل `default`، أي اسم يبدأ بـ `panorama_` يُرسل إلى `panoramaClient.execute` بالسياق:
  ```json
  { "channel": "mazbot", "conversation_key": "mz:9689XXXXXXX", "customer_phone": "9689XXXXXXX", "customer_verified": true, "customer_consent": false }
  ```
  - `customer_verified = true` فقط حين `ctx.phone` موجود والقناة `mazbot` أو `whatsapp`. محادثة الموقع والإدارة → `false` و`customer_phone: null`.
  - يُعاد للنموذج رد بانوراما كما هو: `status` و`data` و`message_for_agent`.
- **قسم في الـ prompt** يُضاف فقط حين تكون أدوات بانوراما ضمن الجولة:
  - `instructions_for_agent` القادم من `/tools`؛
  - وقواعد ثابتة: «لا تذكر سعراً أو منتجاً لبانوراما لم تُرجعه أداة panorama_، وأرسل رابط المنتج، ولا تخلط أسعار ردما وبانوراما في عرض واحد، وفي MIXED اسأل العميل عن النشاط الذي يقصده إن لم يكن واضحاً».
  - **لا يتغير أي سطر** في prompt ردما.
- **`request_human`:** يُضاف الحقل `team` بالقيم `radma_sales` و`panorama_sales` و`null`، بالنوع `["string","null"]` ومطلوباً في `required` ليبقى متوافقاً مع `strict: true`.
  - `null` أو `radma_sales` → السلوك الحالي كما هو.
  - `panorama_sales` → الإيقاف كما اليوم، والتبليغ يُرسل إلى إعداد جديد `panorama_recipients` (أرقام مفصولة بفواصل، وإن كان فارغاً فإلى `mazbot_recipients`)، وتُطلق `handoff.requested`.
  - `notifyHuman(summary, team)`: المداخل تمرر `team`، والقديم يعمل بلا تغيير.

### 5. إطلاق الحدثين (فقط إذا كان `PANORAMA_TOOLS_ENABLED=1`)
- **`lead.message`:** بعد كل رد صُنّفت رسالته `PANORAMA` أو `MIXED`، من مداخل `mazbot` و`whatsapp` و`web`، لا من تجربة الإدارة.
  ```json
  { "lead_id": 123, "channel": "mazbot", "customer_phone": "9689XXXXXXX", "customer_name": "...", "business": "panorama", "text": "نص رسالة العميل", "agent_reply": "نص رد الوكيل" }
  ```
  `business` يكون `panorama` أو `mixed`، و`customer_phone` يكون `null` في محادثة الموقع.
- **`handoff.requested`:** عند `request_human` بـ `team=panorama_sales`.
  ```json
  { "lead_id": 123, "team": "panorama_sales", "customer_phone": "9689XXXXXXX", "summary": "ملخص المحادثة من الوكيل" }
  ```
- الإطلاق عبر `webhooks.emit` القائم، بالغلاف القائم `{id, event, created_at, data}`، وبإعادة المحاولة الموجودة.

### 6. الوضع التجريبي (`shadow`)
- الرسالة التي تُصنَّف `PANORAMA` أو `MIXED`:
  1. يُرد عليها **كما اليوم تماماً**، بأدوات ردما وبالـ prompt الحالي، وهذا الرد هو ما يصل العميل.
  2. في الخلفية، بلا انتظار، يُشغَّل الوكيل مرة ثانية بأدوات بانوراما على نسخة من المحادثة: **لا يحفظ المحادثة، ولا ينفّذ `request_human` ولا `create_*`، ولا يرسل شيئاً.** هذه الأدوات تعيد للنموذج `{"ok": true, "dry_run": true}`.
  3. يُحفظ الرد المقترح في جدول جديد `panorama_shadow_replies` (`id`، `channel`، `business`، `customer_text`، `actual_reply`، `shadow_reply`، `tools_used`، `created_at`) لمدة 30 يوماً، بلا أرقام هواتف.
- لا يُطلق أي Webhook في هذا الوضع.

### 7. لوحة الإدارة: بطاقة «بانوراما» (للمالك فقط)
- **الحالة:** الوضع (`0`/`shadow`/`1`)، والمتغيرات مضبوطة أم لا (بلا قيم)، وحالة قاطع الدائرة، وآخر فحص صحة.
- **زر «اختبار الاتصال»:** يستدعي `GET /tools` ويعرض النتيجة وعدد الأدوات وأسماءها.
- **آخر 50 استدعاء** من `remote_tool_calls`، وإحصاء التوجيه لآخر 7 أيام (عدد RADMA/PANORAMA/MIXED).
- **«ردود بانوراما التجريبية»:** آخر 100 من `panorama_shadow_replies` (رسالة العميل، والرد الفعلي، والرد المقترح، والأدوات).
- حقل الإعداد `panorama_recipients`.

### 8. فحص الصحة
مهمة دورية كل 15 دقيقة (بنمط `scheduled_runs` القائم) تستدعي `GET https://commerce.tech-panorama.com/healthz`. فشلان متتاليان → `alerts.fail('panorama')`، والنجاح → `alerts.ok('panorama')`. لا تعمل في وضع `0`.

### 9. التوثيق
- `.env.example`: المتغيرات الخمسة بلا قيم.
- `README.md`: قسم «ربط وكيل بانوراما»: الأوضاع الثلاثة، وخطوات التفعيل، وقاعدة التوجيه.
- `docs/STATUS.md`: الحدثان صارا يُطلقان (في الوضع `1`)، والمتغيرات، و«آخر التغييرات».

## ما يجب عدم تغييره
- شكل أي endpoint أو حدث Webhook قائم.
- **سلوك ردما مع `PANORAMA_TOOLS_ENABLED=0`:** نفس الأدوات، ونفس الـ prompt، ونفس الردود، ونفس عدد الاستدعاءات للنموذج.
- أدوات ردما الـ 16 ومنطقها، وعروض الأسعار، والإيقاف 12 ساعة، والقوالب، والإشعارات.
- لا تُرسل لبانوراما أي بيانات غير ما في `context` وحجج الأداة. لا يُرسل سجل المحادثة.
- لا أدوات `write` من بانوراما في هذه المهمة.
- لا تبعيات جديدة؛ `fetch` المدمج يكفي.

## العلاقة بالمستودع الآخر
- **المسار:** `https://commerce.tech-panorama.com/api/internal/v1/tools` (GET) و`/tools/execute` (POST).
- **رد بانوراما** دائماً 200 بعد المصادقة:
  ```json
  { "status": "ok", "as_of": "2026-11-26T12:00:00Z", "data": { }, "message_for_agent": null }
  ```
  والحالات: `ok`، `not_found`، `invalid_arguments`، `forbidden`، `unavailable`، `error`. و401 يعني خطأ مفاتيح، و429 يعني تجاوز 120 طلباً في الدقيقة.
- **الأدوات المتاحة الآن (كلها قراءة):**
  `panorama_search_products`، `panorama_get_product_by_sku`، `panorama_get_product_details`، `panorama_check_stock`، `panorama_compare_products`، `panorama_get_product_images`، `panorama_calculate_cart`، `panorama_get_shipping_options`، `panorama_get_order_status`، `panorama_search_knowledge`.
- **ملاحظة:** بانوراما لا يعيد إلا المنتجات المنشورة في المتجر. قبل نشر المنتجات ستعيد أدوات المنتجات `not_found`، وهذا متوقع.
- **الحدثان المرسلان لبانوراما:** يُشترك فيهما من لوحة Webhooks بعنوان `https://commerce.tech-panorama.com/webhooks/aluminum` وسر يُضبط في بانوراما باسم `INBOUND_WEBHOOK_SECRET`.

## معايير القبول
- [ ] مع `0`: كل الاختبارات الحالية تنجح بلا تعديل، واختبار يثبت أن قائمة الأدوات والـ prompt مطابقان لما قبل المهمة.
- [ ] التوقيع مطابق لبانوراما (اختبار بخادم وهمي يتحقق منه بنفس الخوارزمية)، و`GET` موقّع على `<ts>.<rid>.`.
- [ ] الـ router: «كم سعر كاميرا 4 ميجا» → PANORAMA، و«بوابة شتر 3×2.5» → RADMA، و«أبي كاميرا وبوابة» → MIXED، و«السلام عليكم» بعد رسالة كاميرات → PANORAMA (النشاط الحالي).
- [ ] RADMA لا يرى أدوات بانوراما، وPANORAMA لا يرى أدوات ردما عدا `request_human`.
- [ ] قاطع الدائرة: 3 إخفاقات → `unavailable` لمدة 60 ث بلا طلبات شبكة.
- [ ] محادثة الموقع ترسل `customer_verified: false` و`customer_phone: null`.
- [ ] `shadow`: العميل يستلم رد ردما فقط، ويُحفظ الرد المقترح، ولا تُحفظ محادثة ثانية، ولا يُرسل شيء آخر.
- [ ] `1`: يُطلق `lead.message` لرسائل PANORAMA/MIXED، و`handoff.requested` عند `team=panorama_sales`، ولا يُطلقان لرسائل RADMA.
- [ ] `request_human` بلا `team` (أو `null`) يعمل كما اليوم.
- [ ] لا يظهر أي مفتاح في السجلات أو اللوحة، و`remote_tool_calls` بلا أرقام هواتف.
- [ ] الاختبارات تنجح
- [ ] تحديث `docs/STATUS.md`
- [ ] Pull Request على الفرع المقترح (لا push مباشر إلى main)
