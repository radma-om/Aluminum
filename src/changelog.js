/* =============================================================
   The app's versions and what changed in each (newest first), shown to
   staff in «الإصدارات» and in «ما الجديد» after an update.
   Add an entry with every release: a test checks that the newest entry
   is the version in package.json.
   ============================================================= */
module.exports = [
    {
        version: '3.56.0', date: '2026-11-22',
        ar: ['«العروض والهدايا» ← تهنئة العملاء في الحاسبات: رسالة تهنئة مع ألعاب نارية بألوان العلم (مثل «كل عام وعُمان بخير»)، يكتب المدير عنوانها ونصها وآخر يوم لها، مع زر «معاينة»', 'تظهر لكل زائر مرة واحدة، وتُغلق بلمسة أو وحدها بعد ثوانٍ، ولا تظهر داخل إطار الموقع، وبلا حركة لمن طلب تقليل الحركة في جهازه'],
        en: ['«Offers & gifts» → greeting customers in the calculators: a greeting with fireworks in the flag\'s colours (e.g. «Happy National Day, Oman»); the manager writes its title, text and last day, with a «Preview» button', 'Shown once per visitor, closed by a tap or by itself after a few seconds, not inside the company site\'s frame, and without motion for those who asked their device for less']
    },
    {
        version: '3.55.0', date: '2026-11-21',
        ar: ['المبالغ لأقرب 100 بيسة في العروض والفواتير والحاسبات: كل بند، والخصومات، والمجموع (مجموع البنود)، والضريبة، والإجمالي — مثل 225.500 — وأسعار الوحدات كما ضبطها المدير', 'عروض بوابات الشتر: المقاس (العرض × الارتفاع وعدد البوابات) يظهر مع بند الشرائح في ملف PDF وصفحة العرض وقائمة العروض ونافذة العرض والفاتورة ومنشئ العروض، لا المساحة وحدها — والعروض السابقة أيضاً', 'حاسبات العملاء تعرض المبالغ بثلاث خانات (225.500)'],
        en: ['Amounts to the nearest 100 baisa in quotes, invoices and calculators: each line, the discounts, the subtotal (the sum of the lines), VAT and the total — e.g. 225.500 — with unit prices as the manager set them', 'Roller-shutter quotes: the size (width × height and number of gates) shows with the slats line in the PDF, the quote page, the quotes list, the quote and invoice windows and the quote builder, not the area alone — older quotes too', 'Customer calculators show amounts with three digits (225.500)']
    },
    {
        version: '3.54.0', date: '2026-11-21',
        ar: ['عند موافقة العميل على عرضه من صفحة العرض يصل إشعار لكل موظف لديه صلاحية «الفواتير» (ويرى هذا العميل)، إضافة للمديرين وصاحب العرض — أول من يتصل ويُصدر الفاتورة تُحتسب له العمولة', '«طلبات العروض» ← نافذة «وافق العميل على العرض»: من وافق ومتى (بتوقيت مسقط)، ومن ينتظر الفاتورة أولاً مع زر «إصدار فاتورة»، ومن صدرت فاتورته ومن أصدرها'],
        en: ['When a customer accepts their quote from its page, every employee with «Invoices» (who may see this customer) is told too, besides the managers and the quote\'s owner — the first to call and issue the invoice gets the commission', '«Quotes» → «The customer accepted the quote»: who accepted and when (Muscat time), those waiting for the invoice first with «Issue invoice», and those invoiced with who issued it']
    },
    {
        version: '3.53.1', date: '2026-11-21',
        ar: ['تذكير العملاء بانتهاء العرض: زر «إرسال» لكل عميل في القائمة، مع تأكيد يذكر اسمه ورقمه، وتتحدث حالة صفه فوراً — لتجربة الرسالة أو للإرسال لعملاء مختارين', 'نفس القواعد: مرة واحدة لكل رقم في كل عرض، ولا تذكير لعرض صدرت له فاتورة أو من عرض آخر'],
        en: ['Offer-ending reminder: a «Send» button on each customer of the list, with a confirmation naming them and their number, and their row updated at once — to try the message or send to chosen customers', 'The same rules: once per number per offer, never for an invoiced quote or another offer']
    },
    {
        version: '3.53.0', date: '2026-11-21',
        ar: ['«العروض والهدايا» ← تذكير العملاء بانتهاء العرض: قائمة بمن حصل على عرض سعر بالخصم أو الهدية الحالية ولم يُصدر له فاتورة، وزر «إرسال التذكير» على واتساب', 'الرسالة: كم يوفّر العرض، وآخر يوم، ورابط عرض السعر للموافقة — مرة لكل رقم في كل عرض، وتُمدَّد صلاحية عرض السعر حتى آخر يوم'],
        en: ['«Offers & gifts» → remind customers the offer ends: a list of those with a quote under the current discount or gift and no invoice, and a «Send the reminder» button on WhatsApp', 'The message: how much the offer saves, the last day, and the quote link to accept — once per number per offer; the quote\'s validity is extended to the last day']
    },
    {
        version: '3.52.5', date: '2026-11-21',
        ar: ['عند فشل إرسال قالب واتساب يُذكر رقم القالب في سطر الحالة (مثل «فشل 1/4: قالب 3366: …») — في تنبيهات الحاسبات والفواتير وأوامر العمل والتقييم ورمز التحقق، فيُعرف من MazBot أي قالب رُفض ولماذا'],
        en: ['When a WhatsApp template fails, its number is in the status line (e.g. «failed 1/4: template 3366: …») — in the calculator alerts, invoices, work orders, ratings and the verification code — so MazBot shows which template was refused and why']
    },
    {
        version: '3.52.4', date: '2026-11-21',
        ar: ['رمز التحقق في الحاسبات: يُرسل الرمز أيضاً لزر «نسخ الرمز» في قالب المصادقة كما تشترط Meta — كان الإرسال يُرفض بخطأ (#131008)'],
        en: ['The calculators\' verification code: the code is also sent to the Authentication template\'s «Copy code» button, as Meta requires — sends were refused with (#131008)']
    },
    {
        version: '3.52.3', date: '2026-11-21',
        ar: ['«الربط» ← رمز التحقق في الحاسبات: عدد الرموز المرسلة والمؤكدة والفاشلة في آخر 24 ساعة، وسبب آخر فشل في الإرسال كما ذكره MazBot'],
        en: ['«Integrations» → the calculators\' verification code: codes sent, confirmed and failed in the last 24 hours, and MazBot\'s reason for the latest failed send']
    },
    {
        version: '3.52.2', date: '2026-11-21',
        ar: ['«الربط»: زر «فحص الدخول لحسابات MazBot» يوضح لكل حساب (الرئيسي والقوالب) هل يعمل، وما المتغير الناقص أو الخطأ', 'رسالة فشل الدخول تذكر الحساب وسبب رفض MazBot، والمسافات أو علامات التنصيص حول القيم في متغيرات البيئة لا تُفشل الدخول'],
        en: ['«Integrations»: a «Check the MazBot accounts sign-in» button says for each account (main and templates) whether it works, and which variable is missing or what is wrong', 'A failed sign-in names the account and MazBot\'s reason, and spaces or quotes around values in the environment variables no longer break the sign-in']
    },
    {
        version: '3.52.1', date: '2026-11-20',
        ar: ['طلب التقييم: إن فشل إرساله (قالب لم يُعتمد بعد، أو عطل في MazBot) يُعاد بعد 6 ساعات، حتى 3 محاولات خلال الأيام الثلاثة — وكل محاولة مكتوبة في سجل أمر العمل'],
        en: ['Rating request: a failed send (template not approved yet, or MazBot down) is tried again 6 hours later, up to 3 attempts within the 3 days — each attempt is written in the work order log']
    },
    {
        version: '3.52.0', date: '2026-11-20',
        ar: ['تقييم الخدمة على واتساب: في اليوم التالي لاكتمال أمر العمل (من 10 صباحاً) يصل العميل «كيف كانت خدمتنا؟» بأزرار من 5 ممتاز إلى 1 ضعيف', 'تقييم 4–5: شكر مع رابط التقييم على Google؛ تقييم 1–3: اعتذار وسؤال عن السبب، وإشعار فوري للمديرين، وتُحفظ ملاحظة العميل', 'التقييم والملاحظة في سجل أمر العمل وسجل العميل، وملخص آخر 30 يوماً في «الربط»'],
        en: ['Service rating on WhatsApp: the day after a work order is done (from 10 am) the customer gets «How was our service?» with buttons from 5 Excellent to 1 Poor', 'A 4–5 rating is thanked with the Google review link; 1–3 gets an apology asking why, the managers are told at once, and the customer\'s comment is kept', 'The rating and comment are in the work order and customer logs, with a 30-day summary in «Integrations»']
    },
    {
        version: '3.51.0', date: '2026-11-20',
        ar: ['اسم الشركة «ردما للبوابات الإلكترونية» في كل النظام: ملفات PDF، صفحات تتبع الطلب وعرض السعر، ردود واتساب، والمساعد الذكي', 'يُغيَّر تلقائياً إن كان الاسم المحفوظ «رادما» أو الاسم الافتراضي القديم؛ ويبقى قابلاً للتعديل من الإعدادات'],
        en: ['The company name «Radma Electronic Gates» across the system: PDFs, the order tracking and quote pages, WhatsApp replies and the assistant', 'Renamed by itself where the saved name was «Radma» or the old default; still editable in the settings']
    },
    {
        version: '3.50.5', date: '2026-11-20',
        ar: ['رد «تتبع طلبي» على واتساب أوضح: لكل فاتورة أو طلب أو عرض سطر للعنوان، وسطر للمبلغ (والمتبقي للفاتورة)، والرابط في سطر مستقل، وسطر فارغ بين كل واحد والآخر'],
        en: ['The «Track my order» WhatsApp reply is clearer: for each invoice, order or quote a title line, an amount line (and the balance for an invoice), the link on a line of its own, and an empty line between items']
    },
    {
        version: '3.50.4', date: '2026-11-20',
        ar: ['الأيقونات تظهر فوراً: صارت من النظام نفسه بدل موقع خارجي، والأيقونات المستخدمة فقط (13 كيلوبايت بدل نحو 280)، في اللوحة وحاسبات العملاء', 'لوحة المؤشرات: المبالغ بثلاث خانات عشرية مثل باقي النظام'],
        en: ['Icons show at once: they now come from the system itself instead of an outside site, only the icons used (13 KB instead of about 280), in the panel and the customer calculators', 'Dashboard: amounts with three decimals like the rest of the system']
    },
    {
        version: '3.50.3', date: '2026-11-20',
        ar: ['سرعة: كشف العمولات يفتح أسرع بعدة مرات مع كثرة الفواتير، ولوحة المؤشرات وتقرير الموظفين أخف على الخادم', 'حاسبات العملاء تظهر أسرع: الأيقونات تُحمَّل بجانب الصفحة بدل أن تؤخرها', 'حماية: حد لعدد طلبات صفحات «تتبع طلبي» و«عرض السعر» من نفس العنوان'],
        en: ['Speed: the commissions statement opens several times faster with many invoices, and the dashboard and the team report are lighter on the server', 'The customer calculators show sooner: the icons load beside the page instead of holding it back', 'Protection: a limit on requests to the «Track my order» and «Quote» pages from one address']
    },
    {
        version: '3.50.2', date: '2026-11-20',
        ar: ['المبالغ بثلاث خانات عشرية في كل مكان: ملفات PDF للفواتير وعروض الأسعار، لوحة النظام، إشعارات الجوال، التقرير الأسبوعي، سجل العميل وردود المساعد'],
        en: ['Amounts with three decimals everywhere: invoice and quote PDFs, the panel, phone notifications, the weekly report, the customer log and the assistant replies']
    },
    {
        version: '3.50.1', date: '2026-11-20',
        ar: ['مراجعة للأخطاء: رابط عرض سعر أو فاتورة بمفتاح خاطئ يحتوي حروفاً غير لاتينية كان يُظهر «خطأ في الخادم» بدل «غير موجود»', 'رد «إيقاف الإشعارات»: كلمة stop توقف الإشعارات فقط إذا كانت الرسالة كلها، لا إذا وردت داخل جملة', 'رسائل واتساب للعملاء (الفاتورة، الدفعة، المتبقي، عرض السعر) تكتب المبالغ بثلاث خانات عشرية مثل صفحات التتبع'],
        en: ['Bug review: a quote or invoice link with a wrong key holding non-Latin characters showed «server error» instead of «not found»', '«Stop notifications»: the word stop mutes only when it is the whole message, not inside a sentence', 'Customer WhatsApp messages (invoice, payment, balance, quote) write amounts with three decimals, like the tracking pages']
    },
    {
        version: '3.50.0', date: '2026-11-19',
        ar: ['حاسبات العملاء: رمز تحقق من 4 أرقام يصل العميل على واتساب (قالب MazBot المعتمد) ويكتبه في الحاسبة قبل إرسال الطلب', 'مرة كل 30 يوماً لكل رقم؛ يُفعَّل من «الربط» بعد اعتماد القالب (متوقف افتراضياً)'],
        en: ['Customer calculators: a 4-digit verification code reaches the customer on WhatsApp (the approved MazBot template) and is typed in the calculator before the request is sent', 'Once every 30 days per number; switched on from «Integrations» once the template is approved (off by default)']
    },
    {
        version: '3.49.0', date: '2026-11-19',
        ar: ['«عرض السعر جاهز»: إرسال العرض للعميل من رقم الشركة مع رابط صفحة المراجعة والموافقة — من نافذة العرض، أو مباشرة بعد حفظ عرض جديد', 'بعد الإرسال تصبح حالة العرض «تم التواصل»، ويظهر سجل الإرسال في نافذة العرض'],
        en: ['«Quote ready»: send the quote to the customer from the company number with the link to its review and acceptance page — from the quote window, or right after saving a new quote', 'After sending, the quote becomes «contacted», and the send log shows in the quote window']
    },
    {
        version: '3.48.0', date: '2026-11-19',
        ar: ['«عرض السعر»: صفحة خاصة للعميل يراجع فيها البنود والمبالغ والشروط ويضغط «أوافق على العرض» — فيصبح العرض مقبولاً ويصلك إشعار لإصدار الفاتورة', 'في نافذة العرض: «صفحة العرض للعميل» و«نسخ رابط العرض» و«إرسال الرابط من جوالي»', 'رد «تتبع» يرسل رابط صفحة العرض بدل ملف PDF'],
        en: ['«Quote page»: a private page where the customer reviews the lines, amounts and terms and presses «I accept the quote» — the quote becomes accepted and you are notified to issue the invoice', 'In the quote window: «Customer quote page», «Copy the quote link» and «Send the link from my phone»', 'The «Track» reply sends the quote page link instead of the PDF']
    },
    {
        version: '3.47.3', date: '2026-11-19',
        ar: ['«تتبع» يعرض أيضاً عروض الأسعار التي لم تتحول لفاتورة (آخر 90 يوماً) مع رابط PDF العرض وصلاحيته', '«تتبع» يبحث برقم العميل الثاني المسجل في ملفه', 'سجل رسائل حساب القوالب يكتب النتيجة الفعلية (وُجدت طلبات / لا طلبات) ونص الرد المرسل'],
        en: ['«Track» also lists quotes not invoiced yet (last 90 days) with the quote PDF link and its validity', '«Track» also searches the customer\'s second number on their record', 'The templates account log records the actual result (orders found / none) and the reply text sent']
    },
    {
        version: '3.47.2', date: '2026-11-19',
        ar: ['Webhook حساب القوالب: السرّ في متغيرات البيئة يُقبل ولو لُصق بمسافات أو علامات تنصيص', '«توقيع غير صحيح» يوضح السبب: لا ترويسة توقيع من MazBot، أو السرّ لا يطابق سرّ هذا الرابط — مع ترويسات الطلب للتشخيص'],
        en: ['Templates account webhook: the secret in the environment is accepted even when pasted with spaces or quotes', '«Bad signature» now says why: no signature header from MazBot, or the secret does not match this webhook — with the request headers to diagnose']
    },
    {
        version: '3.47.1', date: '2026-11-19',
        ar: ['تبويب «الربط»: قسم جديد لرسائل حساب القوالب — رابط الـWebhook، وكل رسالة وما حدث لها (أوقف الإشعارات، طلب التتبع، تجاهل، توقيع غير صحيح، أو لم يصل الرد وسببه)', 'سجل الرسائل الواردة يحفظ آخر 100 لكل حساب على حدة'],
        en: ['«Integrations» tab: a new section for the templates account messages — its webhook link, and each message with what happened (notices muted, tracking requested, ignored, bad signature, or the reply did not arrive and why)', 'The incoming messages log keeps the latest 100 for each account separately']
    },
    {
        version: '3.47.0', date: '2026-11-19',
        ar: ['إشعارات أوامر العمل للعميل على واتساب مع رابط «تتبع طلبي»: موعد التركيب، الفني في الطريق، بدء العمل، اكتمال العمل والمتبقي', 'زر «في الطريق» للفني في بطاقة أمر العمل', 'العميل يوقف الإشعارات 48 ساعة بزر في الرسالة، ويكتب «تتبع» ليصله رابط طلباته', 'أمر العمل بلا فاتورة له صفحة تتبع خاصة به'],
        en: ['Work order notices to the customer on WhatsApp with the «Track my order» link: the appointment, technician on the way, work started, work done and the balance', 'An «On the way» button for the technician on the work order card', 'The customer mutes notices for 48 hours with a button in the message, and writes «تتبع» to get their order links', 'A work order without an invoice has its own tracking page']
    },
    {
        version: '3.46.0', date: '2026-11-19',
        ar: ['«تتبع طلبي»: صفحة خاصة لكل عميل تعرض مراحل طلبه (عرض السعر، الفاتورة، الدفع، موعد التركيب والفني، التنفيذ، الاكتمال) والمبالغ والمتبقي والفاتورة PDF — بلا تسجيل دخول', 'رسائل واتساب للعميل ترسل رابط صفحة التتبع، وفي الفاتورة زر «صفحة التتبع» و«نسخ رابط التتبع»'],
        en: ['«Track my order»: a private page for each customer showing the steps of their order (quote, invoice, payment, installation appointment and technician, work, done), the amounts, the balance and the invoice PDF — no sign-in', 'WhatsApp messages to the customer send the tracking page link; the invoice has «Tracking page» and «Copy the tracking link»']
    },
    {
        version: '3.45.1', date: '2026-11-19',
        ar: ['حساب MazBot مستقل للقوالب المعتمدة: قوالب الحاسبات لأرقام المبيعات وقوالب العملاء (الفاتورة والدفعة والتذكير) تُرسل منه، ويبقى الحساب الأساسي للرسائل الواردة والمساعد والردود', 'حالة الحسابين في تبويب «الربط»'],
        en: ['A MazBot account of its own for approved templates: the calculators\' templates to the sales numbers and the customer templates (invoice, payment, reminder) go from it, and the main account stays for incoming messages, the assistant and replies', 'Both accounts\' status in the «Integrations» tab']
    },
    {
        version: '3.45.0', date: '2026-11-17',
        ar: ['واتساب للعميل من رقم الشركة: إرسال الفاتورة، وتأكيد كل دفعة، وتذكير بالمتبقي — مع الإجمالي والمدفوع والمتبقي ورابط PDF', 'بعد إصدار الفاتورة أو تسجيل دفعة يسألك النظام: إرسال للعميل الآن؟', 'الفني يرسل فاتورة أمر عمله أو فاتورة الخدمة من رقم الشركة', 'كل إرسال يُسجَّل في الفاتورة وفي سجل العميل، وزر «واتساب من جوالي» يبقى احتياطاً'],
        en: ['WhatsApp to the customer from the company number: the invoice, a confirmation of each payment, and a reminder of the balance — with the total, paid, balance and the PDF link', 'After issuing an invoice or recording a payment you are asked: send to the customer now?', 'The technician sends their work order\'s invoice or the service invoice from the company number', 'Every send is logged on the invoice and in the customer\'s file; «WhatsApp from my phone» stays as a fallback']
    },
    {
        version: '3.44.0', date: '2026-11-17',
        ar: ['«فاتورة خدمة منفصلة»: عند إضافة خدمة على أمر عمل له فاتورة، يختار الفني إضافتها إلى الفاتورة أو إصدار فاتورة مستقلة بالخدمة وحدها وملف PDF يرسله للعميل — والعمولة له في الحالتين', 'العمولات: دفعة سُجّلت متأخرة بتاريخ شهر أُغلق كشفه تُحتسب في أول شهر مفتوح ولا تضيع'],
        en: ['«Separate service invoice»: when adding a service to a work order that has an invoice, the technician chooses to add it to that invoice or issue an invoice of its own with the service alone and a PDF for the customer — the commission is theirs either way', 'Commissions: a payment recorded late, dated in a month already closed, counts in the first open month instead of being lost']
    },
    {
        version: '3.43.4', date: '2026-11-17',
        ar: ['العهدة: الموظف الذي حددت له حداً أدنى خاصاً يظهر له التحذير حتى قبل أول عملية في دفتره', 'العمولات وأداء الموظفين: أمر العمل المكتمل على فاتورة أُلغيت لا يُحسب ضمن الأعمال المنجزة'],
        en: ['Petty cash: an employee given a minimum of their own is warned even before the first entry in their book', 'Commissions and staff performance: a completed work order on a cancelled invoice no longer counts as a job done']
    },
    {
        version: '3.43.3', date: '2026-11-17',
        ar: ['تحذير الحد الأدنى للعهدة لا يظهر لموظف لم يستخدم العهدة أبداً', 'لكل موظف حده الخاص أو «بلا تنبيه» (0) من عمود «الحد الأدنى» في جدول العهد'],
        en: ['The petty cash minimum warning no longer shows for an employee who never used petty cash', 'Each employee can have a limit of their own, or «No alert» (0), from the «Minimum» column of the petty cash table']
    },
    {
        version: '3.43.2', date: '2026-11-17',
        ar: ['العمولات: عربون مؤرخ قبل إصدار الفاتورة يُحتسب في شهر الإصدار، لا في شهر سابق قد يكون أُغلق'],
        en: ['Commissions: a deposit dated before the invoice was issued counts in the month of issue, not in an earlier month that may already be closed']
    },
    {
        version: '3.43.1', date: '2026-11-17',
        ar: ['العهدة تتحدث تلقائياً: عند تأكيد الإرجاع أو إعطاء مبلغ أو أي عملية من جوال آخر يتغير الرصيد والدفتر دون الخروج من التبويب', 'التحديث فوري مع إشعار العهدة، وعند الرجوع إلى التطبيق، وكل 20 ثانية والتبويب مفتوح'],
        en: ['Petty cash refreshes by itself: when a return is confirmed, money is given or any entry is made on another phone, the balance and the book change without leaving the tab', 'At once with a petty cash notification, when you come back to the app, and every 20 seconds while the tab is open']
    },
    {
        version: '3.43.0', date: '2026-11-17',
        ar: ['«تسليم للمكتب» أصبح «إرجاع مبلغ للمكتب»، ولا يُخصم من الرصيد حتى يؤكد المدير أنه استلم المبلغ («استلمته» أو «لم أستلمه» بسبب)', 'زر جديد «استلمت مبلغ»: يسجّل الموظف مبلغاً استلمه (ممن؟) فيُضاف إلى عهدته فوراً، ويصل إشعار للإدارة'],
        en: ['«Return to office» is now «Return money to the office», and it is deducted only once the manager confirms receiving the money («Received» or «Not received» with a reason)', 'A new «I received money» button: the employee records money received (from whom?) and it is added to their petty cash at once; the office is notified']
    },
    {
        version: '3.42.1', date: '2026-11-17',
        ar: ['النسخة الاحتياطية (Excel) تشمل دفاتر العهدة وطلبات المبالغ وصور الإيصالات، وتُستعاد كاملة', 'إذا كبرت النسخة على البريد تُرسل بلا صور الإيصالات (تبقى في النسخ اليومية على الخادم)'],
        en: ['The backup (Excel) includes the petty cash books, money requests and receipt photos, and restores them in full', 'If the backup is too big for email it is sent without the receipt photos (they stay in the daily backups on the server)']
    },
    {
        version: '3.42.0', date: '2026-11-17',
        ar: ['«العهدة والمصروفات»: لكل موظف وفني دفتر عهدة — يستلم مبلغاً ويصرف منه (بترول، أكل، أدوات، قطع…) مع صورة الإيصال، فيتناقص الرصيد', '«طلب مبلغ»: يطلب الفني مبلغاً فيوافق المدير (بالمبلغ نفسه أو غيره) أو يرفض، ويصله إشعار بالرد', 'الإدارة: إشعار مع كل صرف، وإشعار وتنبيه أعلى اللوحة إذا قلّ الرصيد عن الحد الأدنى (عام أو لكل موظف)', 'العمليات لا تُعدَّل؛ المدير يلغي العملية بسبب وتبقى في الدفتر مشطوبة'],
        en: ['«Petty cash»: every employee and technician has a cash book — they receive an amount and spend from it (petrol, food, tools, parts…) with a receipt photo, and the balance goes down', '«Request money»: the technician asks for an amount; the manager approves it (the same or another amount) or declines, and the technician is notified', 'Managers: a notification with each expense, and a notification and a warning at the top of the panel when a balance drops below the minimum (general or per employee)', 'Entries are never edited; a manager cancels one with a reason and it stays in the book, struck through']
    },
    {
        version: '3.41.0', date: '2026-11-17',
        ar: ['«فاتورة خدمة لعميل»: الفني يصدر فاتورة خدمات لعميل جديد أو موجود دون أمر عمل مسبق (يُضاف العميل إلى السجل ويُنشأ أمر عمل «خدمة» باسمه)', 'أكثر من خدمة في الفاتورة الواحدة، و«اكتمل العمل الآن» يسجّل تاريخ الفاتورة والعمولة مباشرة', 'مربع «وصف الخدمة» في عرض السعر بعرض السطر كاملاً', 'النوافذ على الجوال: لا تكبير عند لمس الحقول، والكمية والسعر في صف واحد، وأزرار أمر العمل منظمة، وملاحظة «اكتمل» بعدة أسطر'],
        en: ['«Service invoice for a customer»: the technician issues a service invoice for a new or known customer without a prior work order (the customer is added to the records and a «Service» work order is created in their name)', 'Several services on one invoice; «The work is done now» records the invoice date and the commission at once', 'The «Service description» box in a quote spans the whole line', 'Windows on a phone: no zoom when a field is tapped, quantity and price on one row, tidy work order buttons, and a multi-line «Done» note']
    },
    {
        version: '3.40.0', date: '2026-11-16',
        ar: ['بند «خدمة» بوصفها وسعرها: يضيفه الموظفون والإدارة في عرض السعر، والفني من أمر العمل وهو عند العميل', 'خدمة الفني تُضاف إلى فاتورة أمر العمل (أو تُصدر لها فاتورة جديدة لزيارة الصيانة) ويُفتح ملف PDF ويُرسل للعميل على واتساب', 'عمولة الخدمة للفني بنسبة التركيب نفسها، ولا تدخل في مبيعات موظف المبيعات', 'كل خدمة تُسجَّل في سجل أمر العمل وسجل النشاط، ويصل إشعار للمديرين بسعرها'],
        en: ['A «Service» line with its description and price: staff and managers add it in a quote, the technician from the work order on site', 'The technician\'s service goes on the work order\'s invoice (or a new invoice for a maintenance visit); the PDF opens and can be sent to the customer on WhatsApp', 'The service commission is the technician\'s, at the same % as installation, and is not part of the salesperson\'s sales', 'Each service is recorded in the work order log and the activity log, and the managers are notified of its price']
    },
    {
        version: '3.39.0', date: '2026-11-16',
        ar: ['الفاتورة لها تاريخان: «تاريخ الإصدار» يوم تحويل العرض إلى فاتورة، و«تاريخ الفاتورة» يوم اكتمال العمل', '«تاريخ الفاتورة» يُسجَّل تلقائياً عندما ينهي الفني أو الإدارة آخر أمر عمل للفاتورة، ويمكن تعديله يدوياً', 'التاريخان يظهران في قائمة الفواتير وفي الفاتورة وملف PDF'],
        en: ['An invoice has two dates: «Issue date» when the quote became an invoice, and «Invoice date» when the work was completed', '«Invoice date» is set automatically when the technician or the office finishes the invoice\'s last work order, and can be edited by hand', 'Both dates show in the invoices list, the invoice and its PDF']
    },
    {
        version: '3.38.0', date: '2026-11-16',
        ar: ['مبلغ كل بند = الكمية الظاهرة × سعر الوحدة (لا فرق بيسة عند المراجعة بالآلة الحاسبة)', 'فاتورة شراء بتاريخ أقدم من آخر فاتورة تُسجَّل ولا تغيّر سعر الشراء الحالي', 'العرض الترويجي بلا أجزاء محددة يشمل البضاعة فقط، والتركيب والتوصيل فقط إذا اختارهما المدير', 'المدير يقرر هل يكتب الموظفون «بنوداً حرة» بسعر يدوي، ويرى عددها على العرض', 'المساعد الذكي يقارن الخيارات بالأسعار بعد العرض الترويجي', 'حاسبة التكلفة والربح تبيّن أن الربح غير مكتمل (≤) عند غياب تكلفة بند'],
        en: ['Each line amount = the quantity shown × the unit price (no baisa difference when checked by calculator)', 'A purchase invoice dated before the newest one is recorded without changing the current purchase price', 'A promotion with no parts chosen covers the goods only; installation and delivery only when the manager ticks them', 'The manager decides whether staff may add «free lines» priced by hand, and sees how many a quote has', 'The AI assistant compares options at the prices after the promotion', 'The cost & profit calculator shows the profit as incomplete (≤) when an item has no cost']
    },
    {
        version: '3.37.0', date: '2026-11-16',
        ar: ['إشعارات التحديث 🔔: يرسل المدير إشعاراً عاماً، أو «تحديث متاح»، أو تحديثاً إجبارياً، أو إيقافاً مؤقتاً للتطبيق — ويصل إشعاراً على الجوال', 'التطبيق يعرف وحده أن إصداراً جديداً متاح ويعرض زر «حدّث الآن»', 'صفحة «الإصدارات»: رقم الإصدار الحالي وما الجديد في كل إصدار', 'عرض السعر من ملف العميل متاح أيضاً لمن لديه قسم «متابعة العملاء» فقط'],
        en: ['Update notices 🔔: the manager sends a general notice, «update available», a forced update or a temporary stop of the app — also as a phone notification', 'The app detects a new version by itself and shows «Update now»', '«Versions» page: the current version and what is new in each one', 'Viewing a quote from a customer file also works for staff with only the «Customer Follow-up» section']
    },
    {
        version: '3.36.2', date: '2026-11-16',
        ar: ['عرض السعر من ملف العميل يظهر فوق الملف', 'عرض السعر مضبوط على شاشة الجوال: كل بند في بطاقة'],
        en: ['A quote opened from a customer file now shows on top of it', 'The quote view fits a phone screen: each item is a card']
    },
    {
        version: '3.36.1', date: '2026-11-16',
        ar: ['حاسبة التسعير تطابق أسعار النظام: الضريبة تُضاف مرة واحدة على البيع (ضريبة المشتريات تُسترد)'],
        en: ['The pricing calculator matches the system prices: VAT is added once, on the sale (purchase VAT is reclaimed)']
    },
    {
        version: '3.36.0', date: '2026-11-16',
        ar: ['رقم تسلسلي ثابت لكل عميل (C-0012) وأعمدة جديدة في قائمة العملاء', 'البحث في طلبات العروض باسم العميل أو رقم الجوال أو رقم العرض', 'زر «عرض» يفتح عرض السعر على الشاشة دون تحميل PDF'],
        en: ['A fixed number for each customer (C-0012) and new columns in the customers list', 'Search quote requests by customer name, mobile or quote number', 'The «View» button opens a quote on screen without downloading the PDF']
    },
    {
        version: '3.35.0', date: '2026-11-16',
        ar: ['الإنجليزية: رسائل الخادم والتحذيرات وتشخيص الربط', 'اختيار اللغة من صفحة الدخول يبقى بعد الدخول'],
        en: ['English: server messages, warnings and link diagnostics', 'The language chosen on the sign-in page is kept after sign-in']
    },
    {
        version: '3.34.1', date: '2026-11-15',
        ar: ['القائمة الجانبية تختفي على الجوال بالإنجليزية'],
        en: ['The side menu hides on a phone in English']
    },
    {
        version: '3.34.0', date: '2026-11-15',
        ar: ['الإنجليزية: النصوص داخل الأقسام (القوائم والبطاقات والإحصائيات والنوافذ)'],
        en: ['English: the texts inside the sections (lists, cards, statistics, windows)']
    },
    {
        version: '3.33.0', date: '2026-11-15',
        ar: ['اللغة الإنجليزية للوحة التحكم (زر EN)', 'الاسم «ردما للبوابات الإلكترونية» بجانب الشعار'],
        en: ['English for the admin panel (EN button)', 'The name «Radma Electronic Gates» beside the logo']
    }
];
