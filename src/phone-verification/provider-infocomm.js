/* Infocomm Verify adapter.
   The official endpoint/auth/payload mapping has not arrived yet. This adapter deliberately
   cannot make network requests until that mapping is completed and tested. */
class ProviderNotConfiguredError extends Error {
    constructor() {
        super('خدمة التحقق بانتظار توثيق Infocomm وبيانات الربط، ولم يتم إجراء أي اتصال خارجي.');
        this.code = 'provider_not_configured';
        this.status = 503;
        this.expose = true;
    }
}
function createInfocommProvider(env = process.env) {
    const names = ['INFOCOMM_VERIFY_BASE_URL', 'INFOCOMM_VERIFY_API_KEY', 'INFOCOMM_VERIFY_ACCOUNT_ID', 'INFOCOMM_VERIFY_TEMPLATE_ID'];
    const missing = names.filter((name) => !String(env[name] || '').trim());
    // TODO(INFOCOMM-DOCS): enable only after official endpoints, authentication, fields,
    // error codes, idempotency and webhook signatures are mapped.
    const mappingReady = false;
    const unavailable = async () => { throw new ProviderNotConfiguredError(); };
    return {
        name: 'infocomm',
        isConfigured: () => missing.length === 0 && mappingReady,
        status: () => ({ configured: missing.length === 0 && mappingReady, mapping_ready: mappingReady, missing }),
        requestCode: unavailable,
        verifyCode: unavailable,
        healthCheck: unavailable,
        verifyWebhook: () => { throw new ProviderNotConfiguredError(); },
        parseWebhook: () => { throw new ProviderNotConfiguredError(); }
    };
}
module.exports = { createInfocommProvider, ProviderNotConfiguredError };
