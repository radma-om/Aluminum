/* =============================================================
   Images and voice notes from WhatsApp (MazBot).
   MazBot sends a link to the file in the message:
     { message_type: 'image', header_image: 'https://mazbotapp.s3.<region>.amazonaws.com/…/x.jpg', value: caption|null }
     { message_type: 'audio', header_audio: 'https://mazbotapp.s3.<region>.amazonaws.com/…/x.ogg' }
   - Files are downloaded only from MazBot's storage (never from any other
     address: no one can make the server fetch a link of their choice),
     over https, with a size limit and a timeout; redirects are refused.
   - A voice note becomes text with OpenAI's speech-to-text
     (OPENAI_TRANSCRIBE_MODEL, default gpt-4o-mini-transcribe), then is
     answered like a typed message; an image is shown to the AI model.
   ============================================================= */

const LIMITS = { image: 8 * 1024 * 1024, audio: 12 * 1024 * 1024 };
const FIELDS = { image: 'header_image', audio: 'header_audio', video: 'header_video', document: 'header_document' };
const TIMEOUT_MS = 20_000;

/* MazBot's file storage (S3 bucket "mazbotapp" in any region), and mazbot.net itself */
function isMazbotMedia(value) {
    let u;
    try { u = new URL(String(value)); } catch { return false; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    return /^mazbotapp\.s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(u.hostname) || /^mazbotapp\.s3\.amazonaws\.com$/.test(u.hostname)
        || /^([a-z0-9-]+\.)?mazbot\.net$/.test(u.hostname);
}

/* What a MazBot message carries: { kind, url, caption } or null for plain text */
function mediaOf(event) {
    const m = (event && event.data && event.data.message) || {};
    const kind = String(m.message_type || m.meta_type || '').toLowerCase();
    const type = kind === 'voice' || kind === 'ptt' ? 'audio' : kind;
    if (!FIELDS[type]) return null;
    const url = m[FIELDS[type]] || m.media_url || m.url || null;
    const caption = typeof m.value === 'string' && m.value.trim() ? m.value.trim() : null;
    return { kind: type, url: url ? String(url) : null, caption };
}

const err = (message) => new Error(message);

/* Downloads a MazBot file: { buffer, contentType } — throws with a short reason */
async function download(url, kind) {
    if (!isMazbotMedia(url)) throw err('رابط الملف ليس من خوادم MazBot — لم يُنزَّل');
    const max = LIMITS[kind] || LIMITS.image;
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw err(`تعذر تنزيل الملف (HTTP ${res.status})`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > max) throw err('الملف أكبر من الحد المسموح');
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
        size += chunk.length;
        if (size > max) throw err('الملف أكبر من الحد المسموح');
        chunks.push(chunk);
    }
    const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    return { buffer: Buffer.concat(chunks), contentType };
}

/* Image → what the AI models take: { media_type, data (base64) } */
function imagePart({ buffer, contentType }, url) {
    const byExt = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
    const ext = (String(url).split('?')[0].split('.').pop() || '').toLowerCase();
    const mediaType = /^image\/(jpeg|png|webp|gif)$/.test(contentType) ? contentType : byExt[ext];
    if (!mediaType) throw err('نوع الصورة غير مدعوم');
    return { media_type: mediaType, data: buffer.toString('base64') };
}

const canTranscribe = () => Boolean(process.env.OPENAI_API_KEY);

/* Voice note → text (OpenAI speech-to-text). The hint helps with the trade's words and numbers. */
async function transcribe({ buffer, contentType }, url) {
    if (!canTranscribe()) throw err('تحويل الصوت إلى نص يحتاج OPENAI_API_KEY');
    const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const name = (String(url).split('?')[0].split('/').pop() || 'voice.ogg').replace(/[^A-Za-z0-9._-]/g, '') || 'voice.ogg';
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: contentType || 'audio/ogg' }), name);
    form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe');
    form.append('prompt', 'محادثة مع شركة بوابات رول شتر وأوفرهيد ومكائن في عُمان: مقاسات بالمتر والسنتيمتر، أسعار، ولايات.');
    const res = await fetch(base + '/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
        body: form,
        signal: AbortSignal.timeout(60_000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw err(`تحويل الصوت فشل: ${(data.error && data.error.message) || 'HTTP ' + res.status}`);
    return String(data.text || '').trim();
}

module.exports = { mediaOf, isMazbotMedia, download, imagePart, transcribe, canTranscribe, LIMITS };
