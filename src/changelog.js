/* =============================================================
   The app's versions and what changed in each (newest first), shown to
   staff in «الإصدارات» and in «ما الجديد» after an update.
   Add an entry with every release: a test checks that the newest entry
   is the version in package.json.
   ============================================================= */
module.exports = [
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
