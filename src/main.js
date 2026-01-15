// AliExpress Product Scraper - Production-ready with exact JSON path extraction
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { Actor, log } from 'apify';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    keyword = 'Towel',
    startUrl,
    category,
    minPrice,
    maxPrice,
    sortBy = 'default',
    results_wanted: RESULTS_WANTED_RAW = 20,
    proxyConfiguration: proxyConfig,
} = input;

const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 20;

log.info(`Starting AliExpress scraper for keyword: "${keyword}", results wanted: ${RESULTS_WANTED}`);

// Build search URL
const buildSearchUrl = (kw, page = 1) => {
    const encodedKeyword = encodeURIComponent(kw.trim().replace(/\s+/g, '-'));
    const u = new URL(`https://www.aliexpress.com/w/wholesale-${encodedKeyword}.html`);
    if (page > 1) u.searchParams.set('page', String(page));
    if (sortBy === 'price_asc') u.searchParams.set('SortType', 'price_asc');
    else if (sortBy === 'price_desc') u.searchParams.set('SortType', 'price_desc');
    else if (sortBy === 'orders') u.searchParams.set('SortType', 'total_tranpro_desc');
    if (minPrice) u.searchParams.set('minPrice', String(minPrice));
    if (maxPrice) u.searchParams.set('maxPrice', String(maxPrice));
    if (category) u.searchParams.set('CatId', String(category));
    return u.href;
};

// Normalize image URL
const normalizeImageUrl = (url) => {
    if (!url) return null;
    let cleanUrl = url.startsWith('//') ? `https:${url}` : url;
    return cleanUrl.split('?')[0];
};

// Parse sold count from text like "10,000+ sold"
const parseSoldCount = (text) => {
    if (!text) return null;
    const match = String(text).match(/([\d,.]+)\+?\s*(sold|orders)?/i);
    return match ? parseInt(match[1].replace(/[,.\s]/g, ''), 10) : null;
};

// Create proxy configuration
const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig || {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
});

let saved = 0;
const seenIds = new Set();
const initial = startUrl
    ? [{ url: startUrl, userData: { pageNo: 1 } }]
    : [{ url: buildSearchUrl(keyword, 1), userData: { pageNo: 1 } }];

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestRetries: 5,
    useSessionPool: true,
    sessionPoolOptions: {
        maxPoolSize: 5,
        sessionOptions: { maxUsageCount: 3 },
    },
    maxConcurrency: 2,
    requestHandlerTimeoutSecs: 90,
    navigationTimeoutSecs: 60,
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: ['firefox'],
                operatingSystems: ['windows'],
                devices: ['desktop'],
            },
        },
    },
    preNavigationHooks: [
        async ({ page }) => {
            // Block heavy resources (NOT stylesheets - they're needed)
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                const url = route.request().url();

                if (['image', 'font', 'media'].includes(type) ||
                    url.includes('google-analytics') ||
                    url.includes('googletagmanager') ||
                    url.includes('facebook') ||
                    url.includes('doubleclick') ||
                    url.includes('pinterest')) {
                    return route.abort();
                }
                return route.continue();
            });

            // Stealth
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });
        },
    ],
    async requestHandler({ page, request, crawler: crawlerInstance }) {
        const pageNo = request.userData?.pageNo || 1;
        log.info(`Processing page ${pageNo}: ${request.url}`);

        // Wait for page to load
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(3000); // Let JS execute

        // Extract products using exact JSON path via page.evaluate()
        const result = await page.evaluate(() => {
            try {
                // Exact path found during debugging
                const products = window._dida_config_?._init_data_?.data?.data?.root?.fields?.mods?.itemList?.content;

                if (!products || !Array.isArray(products)) {
                    return { error: 'Products not found at expected path', products: [] };
                }

                return {
                    products: products.map(item => {
                        const data = item.item || item;
                        return {
                            productId: String(data.productId || data.itemId || ''),
                            title: data.title?.displayTitle || data.title?.seoTitle ||
                                (typeof data.title === 'string' ? data.title : null),
                            salePrice: data.prices?.salePrice?.formattedPrice ||
                                data.prices?.salePrice?.minPrice || null,
                            originalPrice: data.prices?.originalPrice?.formattedPrice || null,
                            imageUrl: data.image?.imgUrl || null,
                            rating: data.evaluation?.starRating || null,
                            reviewCount: data.evaluation?.totalCount || null,
                            tradeDesc: data.trade?.tradeDesc || null,
                            storeName: data.store?.storeName || null,
                            storeId: data.store?.storeId || null,
                            productUrl: data.productDetailUrl || null,
                        };
                    }),
                    count: products.length,
                };
            } catch (e) {
                return { error: e.message, products: [] };
            }
        });

        if (result.error) {
            log.warning(`Extraction error: ${result.error}`);
        }

        log.info(`Found ${result.count || 0} products in _dida_config_`);

        const products = [];
        for (const item of result.products || []) {
            if (!item.productId || !item.title) continue;

            products.push({
                product_id: item.productId,
                title: item.title,
                price: item.salePrice,
                original_price: item.originalPrice,
                currency: 'USD',
                rating: item.rating,
                reviews_count: item.reviewCount,
                orders: parseSoldCount(item.tradeDesc),
                store_name: item.storeName,
                store_url: item.storeId ? `https://www.aliexpress.com/store/${item.storeId}` : null,
                image_url: normalizeImageUrl(item.imageUrl),
                product_url: item.productUrl
                    ? (item.productUrl.startsWith('//') ? `https:${item.productUrl}` : item.productUrl)
                    : `https://www.aliexpress.com/item/${item.productId}.html`,
            });
        }

        log.info(`Extracted ${products.length} valid products`);

        // Save products
        const newProducts = [];
        for (const product of products) {
            if (saved >= RESULTS_WANTED) break;

            if (!seenIds.has(product.product_id)) {
                seenIds.add(product.product_id);
                newProducts.push(product);
                saved++;
            }
        }

        if (newProducts.length > 0) {
            await Dataset.pushData(newProducts);
            log.info(`Saved ${newProducts.length} new products. Total: ${saved}/${RESULTS_WANTED}`);
        }

        // Pagination
        if (saved < RESULTS_WANTED && products.length > 0) {
            const nextPage = pageNo + 1;
            log.info(`Enqueueing page ${nextPage}...`);
            await crawlerInstance.addRequests([{
                url: buildSearchUrl(keyword, nextPage),
                userData: { pageNo: nextPage },
            }]);
        }
    },

    failedRequestHandler({ request }, error) {
        log.error(`Request ${request.url} failed: ${error.message}`);
    },
});

await crawler.run(initial);
log.info(`Scraping completed. Total products saved: ${saved}`);
await Actor.exit();
