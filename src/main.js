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

        // Extract products using multiple JSON paths via page.evaluate()
        const result = await page.evaluate(() => {
            try {
                // Try multiple possible paths for product data (AliExpress changes structure)
                let products = null;

                // Path 1: Original path
                products = window._dida_config_?._init_data_?.data?.data?.root?.fields?.mods?.itemList?.content;

                // Path 2: Alternative path structure
                if (!products || !Array.isArray(products)) {
                    products = window._dida_config_?._init_data_?.data?.root?.fields?.mods?.itemList?.content;
                }

                // Path 3: Another common structure
                if (!products || !Array.isArray(products)) {
                    products = window._dida_config_?._init_data_?.data?.data?.root?.mods?.itemList?.content;
                }

                // Path 4: Direct itemList access
                if (!products || !Array.isArray(products)) {
                    const initData = window._dida_config_?._init_data_;
                    if (initData) {
                        const searchDeep = (obj, key, depth = 0) => {
                            if (depth > 8 || !obj || typeof obj !== 'object') return null;
                            if (obj[key] && Array.isArray(obj[key])) return obj[key];
                            if (obj.content && Array.isArray(obj.content)) return obj.content;
                            for (const k of Object.keys(obj)) {
                                const found = searchDeep(obj[k], key, depth + 1);
                                if (found) return found;
                            }
                            return null;
                        };
                        products = searchDeep(initData, 'content');
                    }
                }

                if (!products || !Array.isArray(products)) {
                    return { error: 'Products not found at any known path', products: [], debug: Object.keys(window._dida_config_ || {}) };
                }

                return {
                    products: products.map(item => {
                        const data = item.item || item.productItem || item;

                        // Extract rating from multiple possible locations
                        const rating = data.evaluation?.starRating ||
                            data.evaluation?.value ||
                            data.trace?.starRating ||
                            data.starRating ||
                            data.averageStar ||
                            data.rating ||
                            null;

                        // Extract review count from multiple locations - check trace object too
                        const reviewCount = data.trace?.reviewCount ||
                            data.trace?.review ||
                            data.evaluation?.totalCount ||
                            data.evaluation?.count ||
                            data.evaluation?.totalValidNum ||
                            data.reviewCount ||
                            data.reviews ||
                            data.totalReviews ||
                            data.totalValidNum ||
                            null;

                        // Extract trade/orders from multiple locations
                        const tradeDesc = data.trade?.tradeDesc ||
                            data.trade?.value ||
                            data.trace?.tradeDesc ||
                            data.tradeDesc ||
                            data.sold ||
                            data.orders ||
                            data.salesCount ||
                            null;

                        // Extract store info - check selling points and trace object
                        const storeName = data.store?.storeName ||
                            data.store?.name ||
                            data.trace?.storeName ||
                            data.sellingPoints?.storeName ||
                            data.storeName ||
                            data.sellerName ||
                            data.seller?.name ||
                            data.shopName ||
                            null;

                        // Extract storeId - check multiple locations including trace
                        const storeId = data.store?.storeId ||
                            data.store?.id ||
                            data.trace?.storeId ||
                            data.trace?.sellerId ||
                            data.storeId ||
                            data.sellerId ||
                            data.seller?.id ||
                            data.shopId ||
                            null;

                        // Extract store URL directly if available
                        const storeUrl = data.store?.storeUrl ||
                            data.store?.url ||
                            data.storeUrl ||
                            data.shopUrl ||
                            null;

                        // Extract price from multiple locations
                        const salePrice = data.prices?.salePrice?.formattedPrice ||
                            data.prices?.salePrice?.minPrice ||
                            data.prices?.salePrice?.value ||
                            data.salePrice?.formattedPrice ||
                            data.price?.formattedPrice ||
                            data.price?.value ||
                            data.currentPrice ||
                            data.price ||
                            null;

                        const originalPrice = data.prices?.originalPrice?.formattedPrice ||
                            data.prices?.originalPrice?.value ||
                            data.originalPrice?.formattedPrice ||
                            data.originalPrice ||
                            null;

                        // Get product URL safely
                        let productUrl = data.productDetailUrl || data.detailUrl || data.url || null;
                        // Handle relative URLs
                        if (productUrl && typeof productUrl === 'string') {
                            productUrl = productUrl.trim();
                            if (productUrl.startsWith('//')) {
                                productUrl = 'https:' + productUrl;
                            } else if (productUrl.startsWith('/')) {
                                productUrl = 'https://www.aliexpress.com' + productUrl;
                            }
                        }

                        return {
                            productId: String(data.productId || data.itemId || data.id || ''),
                            title: data.title?.displayTitle || data.title?.seoTitle ||
                                data.title?.text || (typeof data.title === 'string' ? data.title : null),
                            salePrice: salePrice,
                            originalPrice: originalPrice,
                            imageUrl: data.image?.imgUrl || data.image?.url || data.imageUrl || data.img || null,
                            rating: rating,
                            reviewCount: reviewCount,
                            tradeDesc: tradeDesc,
                            storeName: storeName,
                            storeId: storeId,
                            storeUrl: storeUrl,
                            productUrl: productUrl,
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
                store_url: item.storeUrl
                    ? (item.storeUrl.startsWith('//') ? `https:${item.storeUrl}` : item.storeUrl)
                    : (item.storeId ? `https://www.aliexpress.com/store/${item.storeId}` : null),
                image_url: normalizeImageUrl(item.imageUrl),
                product_url: (() => {
                    try {
                        if (!item.productUrl || typeof item.productUrl !== 'string') {
                            return `https://www.aliexpress.com/item/${item.productId}.html`;
                        }
                        const url = item.productUrl.trim();
                        // Validate URL by trying to construct it
                        new URL(url.startsWith('http') ? url : `https://www.aliexpress.com${url.startsWith('/') ? '' : '/'}${url}`);
                        return url.startsWith('http') ? url : `https://www.aliexpress.com${url.startsWith('/') ? '' : '/'}${url}`;
                    } catch (e) {
                        return `https://www.aliexpress.com/item/${item.productId}.html`;
                    }
                })(),
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
