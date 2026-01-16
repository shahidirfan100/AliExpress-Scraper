// AliExpress Product Scraper - Production-ready with robust extraction
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
    requestHandlerTimeoutSecs: 120,
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

        // Wait for page to fully load
        await page.waitForLoadState('domcontentloaded');
        await page.waitForLoadState('networkidle').catch(() => { });

        // Retry loop - wait for _dida_config_ to be populated with product data
        let retries = 0;
        const maxRetries = 15;
        let extractedProducts = [];

        while (retries < maxRetries && extractedProducts.length === 0) {
            await page.waitForTimeout(1000); // Wait 1 second between attempts
            retries++;

            // Extract products using multiple JSON paths via page.evaluate()
            const result = await page.evaluate(() => {
                try {
                    // Check if _dida_config_ exists
                    if (!window._dida_config_) {
                        return { error: '_dida_config_ not found yet', products: [], retry: true };
                    }

                    // Try multiple possible paths for product data
                    let products = null;

                    // Path 1: Most common path
                    products = window._dida_config_?._init_data_?.data?.data?.root?.fields?.mods?.itemList?.content;

                    // Path 2: Alternative structure
                    if (!products || !Array.isArray(products) || products.length === 0) {
                        products = window._dida_config_?._init_data_?.data?.root?.fields?.mods?.itemList?.content;
                    }

                    // Path 3: Another structure
                    if (!products || !Array.isArray(products) || products.length === 0) {
                        products = window._dida_config_?._init_data_?.data?.data?.root?.mods?.itemList?.content;
                    }

                    // Path 4: Without nested data
                    if (!products || !Array.isArray(products) || products.length === 0) {
                        products = window._dida_config_?._init_data_?.root?.fields?.mods?.itemList?.content;
                    }

                    // Path 5: Direct mods access
                    if (!products || !Array.isArray(products) || products.length === 0) {
                        products = window._dida_config_?.mods?.itemList?.content;
                    }

                    // Path 6: Deep search for product arrays
                    if (!products || !Array.isArray(products) || products.length === 0) {
                        const searchForProducts = (obj, depth = 0) => {
                            if (depth > 12 || !obj || typeof obj !== 'object') return null;

                            // Check if this object has itemList.content
                            if (obj.itemList?.content && Array.isArray(obj.itemList.content) && obj.itemList.content.length > 0) {
                                return obj.itemList.content;
                            }

                            // Check if this object IS the content array with product-like items
                            if (Array.isArray(obj) && obj.length > 0 && (obj[0]?.productId || obj[0]?.itemId || obj[0]?.item?.productId)) {
                                return obj;
                            }

                            // Recursively search (prioritize likely keys)
                            const priorityKeys = ['mods', 'fields', 'root', 'data', 'itemList', 'content'];
                            const sortedKeys = Object.keys(obj).sort((a, b) => {
                                const aIdx = priorityKeys.indexOf(a);
                                const bIdx = priorityKeys.indexOf(b);
                                if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
                                if (aIdx !== -1) return -1;
                                if (bIdx !== -1) return 1;
                                return 0;
                            });

                            for (const key of sortedKeys) {
                                if (key === 'content' && Array.isArray(obj[key]) && obj[key].length > 0 &&
                                    (obj[key][0]?.productId || obj[key][0]?.itemId || obj[key][0]?.item?.productId)) {
                                    return obj[key];
                                }
                                const found = searchForProducts(obj[key], depth + 1);
                                if (found) return found;
                            }
                            return null;
                        };

                        products = searchForProducts(window._dida_config_);
                    }

                    if (!products || !Array.isArray(products) || products.length === 0) {
                        return { error: 'Products not found', products: [], retry: true };
                    }

                    // Map products to normalized format
                    return {
                        products: products.map(item => {
                            const data = item.item || item.productItem || item;
                            const utLogMap = data.trace?.utLogMap || {};

                            // Parse p4pExtendParam for sponsored/ad items
                            let p4pData = {};
                            try {
                                if (data.custom?.p4pExtendParam) {
                                    p4pData = JSON.parse(data.custom.p4pExtendParam);
                                }
                            } catch (e) {
                                p4pData = {};
                            }

                            // Extract rating
                            const rating = data.evaluation?.starRating ||
                                data.evaluation?.value ||
                                data.trace?.starRating ||
                                data.starRating ||
                                data.averageStar ||
                                data.rating ||
                                null;

                            // Extract review count
                            const reviewCount = data.evaluation?.totalValidNum ||
                                utLogMap.totalValidNum ||
                                utLogMap.review_count ||
                                utLogMap.ratingCount ||
                                p4pData.totalValidNum ||
                                p4pData.review_count ||
                                data.evaluation?.totalCount ||
                                data.evaluation?.count ||
                                data.reviewCount ||
                                data.reviews ||
                                null;

                            // Extract trade/orders
                            const tradeDesc = data.trade?.tradeDesc ||
                                data.trade?.value ||
                                data.trace?.tradeDesc ||
                                utLogMap.real_trade_count ||
                                p4pData.real_trade_count ||
                                data.tradeDesc ||
                                data.sold ||
                                data.orders ||
                                null;

                            // Extract store info
                            const storeName = p4pData.store_name ||
                                p4pData.company_name ||
                                utLogMap.store_name ||
                                utLogMap.company_name ||
                                data.store?.storeName ||
                                data.store?.name ||
                                data.storeName ||
                                data.sellerName ||
                                null;

                            // Extract storeId/sellerId
                            const storeId = p4pData.seller_id ||
                                p4pData.sellerId ||
                                utLogMap.seller_id ||
                                utLogMap.sellerId ||
                                data.store?.storeId ||
                                data.store?.id ||
                                data.storeId ||
                                data.sellerId ||
                                null;

                            // Extract store URL
                            const storeUrl = p4pData.storeUrl ||
                                data.store?.storeUrl ||
                                data.store?.url ||
                                data.storeUrl ||
                                null;

                            // Extract prices
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

                            // Get product URL
                            let productUrl = data.productDetailUrl || data.detailUrl || data.url || null;
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
                                salePrice,
                                originalPrice,
                                imageUrl: data.image?.imgUrl || data.image?.url || data.imageUrl || data.img || null,
                                rating,
                                reviewCount,
                                tradeDesc,
                                storeName,
                                storeId,
                                storeUrl,
                                productUrl,
                            };
                        }),
                        count: products.length,
                    };
                } catch (e) {
                    return { error: e.message, products: [], retry: true };
                }
            });

            if (result.error && result.retry) {
                log.debug(`Attempt ${retries}/${maxRetries}: ${result.error}`);
                continue;
            }

            if (result.products && result.products.length > 0) {
                extractedProducts = result.products;
                log.info(`Found ${result.count || extractedProducts.length} products after ${retries} attempts`);
            }
        }

        if (extractedProducts.length === 0) {
            log.warning(`No products found after ${maxRetries} attempts`);
            return;
        }

        // Process and save products
        const products = [];
        for (const item of extractedProducts) {
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
