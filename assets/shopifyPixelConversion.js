const PROGRAM_ID = 'YOUR_PROGRAM_ID';
const KEY = 'YOUR_KEY';
const AFFILAE_TRACKING = 'https://lb.affilae.com/';
const VERSION = '1.7.4';
const DEBUG_BEACON_ENABLED = false; // diagnostic beacons (below); enable only for a time-boxed measurement window
const CIDS_READ_TIMEOUT_MS = 1000; // ms; upper bound on the storage read before the hit is sent without click ids
const BYPASS_CUSTOMER_PRIVACY = false; // true = send even when the visitor REFUSED marketing consent. Legal decision: only with a written legal basis, and set the pixel's Shopify permission to "Not required" too
const PRICES_TAX_INCLUDED = true; // true ONLY if displayed prices include VAT: Shopify > Settings > Taxes and duties > "Include sales tax in product price". Silently shifts every amount if wrong: -16.7% when set true on tax-EXCLUSIVE prices, +20% when set false on tax-INCLUSIVE ones (at 20% VAT; proportional to the rate)

let marketingAllowed = init?.customerPrivacy?.marketingAllowed;

if (typeof customerPrivacy !== 'undefined') {
    customerPrivacy.subscribe('visitorConsentCollected', (event) => {
        marketingAllowed = event.customerPrivacy.marketingAllowed;
    });
}

function aeGateway(checkout) {
    const transactions = (checkout && checkout.transactions) || [];

    if (transactions.length === 0) {
        return 'none';
    }

    const transaction = transactions[0] || {};
    const method = transaction.paymentMethod;
    let gateway = transaction.gateway;
    if (!gateway && method) {
        gateway = (typeof method === 'object') ? (method.name || method.type) : method;
    }

    return gateway ? encodeURIComponent(String(gateway).slice(0, 40)) : 'unnamed';
}

function aeBeacon(eventName, checkout) {
    if (!DEBUG_BEACON_ENABLED) {
        return;
    }

    const aeConsent = marketingAllowed === true ? 'granted' : (marketingAllowed === false ? 'denied' : 'unknown');

    let aeBeaconUrl = AFFILAE_TRACKING + '?ae_event=' + eventName;
    aeBeaconUrl += '&pid=' + PROGRAM_ID;
    aeBeaconUrl += '&consent=' + aeConsent;
    aeBeaconUrl += '&gateway=' + aeGateway(checkout);
    aeBeaconUrl += '&source=shopify';
    aeBeaconUrl += '&v=' + VERSION;

    fetch(aeBeaconUrl, {
        'method': 'GET',
        'keepalive': true,
        'referrer': 'about:client'
    }).catch(() => {});
}

analytics.subscribe('payment_info_submitted', (event) => {
    try {
        aeBeacon('payment_submitted', event.data && event.data.checkout);
    } catch (error) {
        console.log(error);
    }
});

analytics.subscribe('checkout_completed', async (event) => {
    try {
        aeBeacon('checkout_seen', event.data && event.data.checkout);

        const aeConsentDenied = marketingAllowed === false;
        const aeConsentUnknown = marketingAllowed === undefined;
        const aeConsentBypassed = aeConsentDenied && BYPASS_CUSTOMER_PRIVACY;
        const aeVoucherOnly = aeConsentDenied && !aeConsentBypassed;

        const checkout = event.data.checkout;

        if (!checkout.order || !checkout.order.id) {
            return;
        }

        const discountCodes = (checkout.discountApplications || [])
            .filter((discount) => discount.type === 'DISCOUNT_CODE' || discount.type === 'code')
            .map((discount) => discount.title)
            .filter((title) => title !== null && title !== undefined && title !== '');

        if (aeVoucherOnly && discountCodes.length === 0) {
            return;
        }

        let aeCidsTimedOut = false;
        let aeCids = [null, null];
        if (!aeVoucherOnly) {
            const aeCidsLocalStorage = browser.localStorage.getItem('aeEvents' + PROGRAM_ID);
            const aeCidsCookie = browser.cookie.get('_affilae' + PROGRAM_ID);
            aeCids = await Promise.race([
                Promise.all([aeCidsLocalStorage, aeCidsCookie]),
                new Promise((resolve) => setTimeout(() => {
                    aeCidsTimedOut = true;
                    resolve([null, null]);
                }, CIDS_READ_TIMEOUT_MS))
            ]);
        }

        const productIds = (checkout.lineItems || [])
            .map((line) => line.variant?.product?.id)
            .filter((id) => id !== null && id !== undefined && id !== '');

        const subtotal = checkout.subtotalPrice ? checkout.subtotalPrice.amount : 0;
        const totalPriceAmount = checkout.totalPrice ? checkout.totalPrice.amount : 0;
        const totalTaxAmount = checkout.totalTax ? checkout.totalTax.amount : 0;
        let amountExVat = subtotal;
        if (PRICES_TAX_INCLUDED) {
            const exVatTotal = totalPriceAmount - totalTaxAmount;      // all-in ex-VAT (any destination)
            if (totalTaxAmount > 0 && exVatTotal <= 0) {
                return;
            }
            const vatRate = (exVatTotal > 0) ? (totalTaxAmount / exVatTotal) : 0;
            amountExVat = subtotal / (1 + vatRate);
        }
        const orderAmountFinal = (amountExVat < 0) ? 0 : amountExVat;

        let aeConvUrl = AFFILAE_TRACKING + '?key=' + KEY;
        aeConvUrl += '&id=' + checkout.order.id;
        aeConvUrl += '&amount=' + orderAmountFinal.toFixed(2);
        aeConvUrl += '&payment=online';
        aeConvUrl += '&voucher=' + discountCodes.map((code) => encodeURIComponent(code)).join(';');
        aeConvUrl += '&product=' + productIds.join(';');
        const currencyCode = checkout.totalPrice ? checkout.totalPrice.currencyCode : null;
        if (currencyCode) {
            aeConvUrl += '&currency=' + currencyCode;
        }
        const customerId = checkout.order?.customer?.id;
        if (customerId && !aeVoucherOnly) {
            aeConvUrl += '&customer=' + customerId;
        }

        if (aeCids[0]) {
            try {
                aeConvUrl += '&cids=' + JSON.parse(aeCids[0]).value;
                aeConvUrl += '&type=ls';
            } catch (e) {
                if (aeCids[1]) {
                    aeConvUrl += '&cids=' + aeCids[1];
                    aeConvUrl += '&type=cookie';
                }
            }
        } else if (aeCids[1]) {
            aeConvUrl += '&cids=' + aeCids[1];
            aeConvUrl += '&type=cookie';
        }

        aeConvUrl += '&source=shopify';
        aeConvUrl += '&v=' + VERSION;
        if (aeCidsTimedOut) {
            aeConvUrl += '&ae_cids_timeout=1';
        }
        if (aeConsentBypassed) {
            aeConvUrl += '&ae_consent_bypass=1';
        }
        if (aeConsentUnknown) {
            aeConvUrl += '&ae_consent_unknown=1';
        }
        if (aeVoucherOnly) {
            aeConvUrl += '&ae_consent_voucher_only=1';
        }

        fetch(aeConvUrl, {
            'method': 'GET',
            'keepalive': true,
            'referrer': 'about:client',
        }).catch((err) => console.error('Affilae tracking error:', err));
    } catch (error) {
        console.log(error);
    }
});
