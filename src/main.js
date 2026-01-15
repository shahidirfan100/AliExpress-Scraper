// AliExpress Product Scraper - Cost-effective JSON extraction via Playwright
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { Actor, log } from 'apify';

// Initialize Apify SDK
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
    cleanUrl = cleanUrl.split('?')[0];
    return cleanUrl;
};

// Parse sold/orders count
const parseSoldCount = (text) => {
    if (!text) return null;
    const match = String(text).match(/([\d,.]+)\+?\s*(sold|orders|pcs)?/i);
    if (match) {
        return parseInt(match[1].replace(/[,.\s]/g, ''), 10) || null;
    }
    return null;
};

// Extract price from various formats
const extractPriceValue = (priceData) => {
    if (!priceData) return null;
    if (typeof priceData === 'number') return String(priceData);
    if (typeof priceData === 'string') return priceData;
    if (priceData.formattedPrice) return priceData.formattedPrice;
    if (priceData.minPrice) return String(priceData.minPrice);
    if (priceData.value) return String(priceData.value);
    return null;
};

// Recursively find product array in JSON
const findProductArray = (obj, depth = 0) => {
    if (depth > 12 || !obj) return null;

    if (Array.isArray(obj) && obj.length > 0) {
        const firstItem = obj[0];
        if (firstItem && (firstItem.productId || firstItem.itemId || firstItem.id || firstItem.item)) {
            return obj;
        }
    }

    if (typeof obj === 'object' && obj !== null) {
        // Priority keys
        const priorityKeys = ['itemList', 'items', 'products', 'list', 'mods', 'data', 'content'];
        const allKeys = Object.keys(obj);
        const sortedKeys = [...priorityKeys.filter(k => allKeys.includes(k)), ...allKeys.filter(k => !priorityKeys.includes(k))];

        for (const key of sortedKeys) {
            const result = findProductArray(obj[key], depth + 1);
            if (result) return result;
        }
    }
    return null;
};

// Extract products from JSON data
const extractProductsFromJson = (jsonData) => {
    const products = [];

    try {
        const itemList = findProductArray(jsonData);
        if (!itemList || itemList.length === 0) {
            log.warning('No product array found in JSON');
            return [];
        }

        log.info(`Found ${itemList.length} items in JSON`);

        for (const item of itemList) {
            if (!item) continue;

            // Handle nested item structure
            const data = item.item || item;

            const productId = String(data.productId || data.itemId || data.id || '');
            if (!productId) continue;

            // Title extraction
            let title = null;
            if (data.title) {
                title = typeof data.title === 'object' ? (data.title.displayTitle || data.title.seoTitle) : data.title;
            }
            title = title || data.productTitle || data.name || null;
            if (!title) continue;

            // Price extraction
            const price = extractPriceValue(
                data.prices?.salePrice || data.salePrice || data.price || data.prices?.minPrice
            );
            const originalPrice = extractPriceValue(
                data.prices?.originalPrice || data.oriPrice || data.originalPrice
            );

            // Rating & reviews
            const rating = data.evaluation?.starRating || data.starRating || data.averageStar || data.rating || null;
            const reviewsCount = data.evaluation?.totalCount || data.reviewCount || data.reviewsCount || null;

            // Orders
            const orders = parseSoldCount(
                data.trade?.tradeDesc || data.tradeDesc || data.salesCount || data.soldCount || data.sold
            );

            // Store info
            const storeName = data.store?.storeName || data.storeName || data.shopName || null;
            let storeUrl = data.store?.storeUrl || null;
            if (storeUrl && storeUrl.startsWith('//')) storeUrl = `https:${storeUrl}`;
            if (!storeUrl && data.store?.storeId) storeUrl = `https://www.aliexpress.com/store/${data.store.storeId}`;

            // Image
            let imageUrl = data.image?.imgUrl || data.imageUrl || data.img || data.productImage || null;
            imageUrl = normalizeImageUrl(imageUrl);

            // Product URL
            let productUrl = data.productDetailUrl || null;
            if (productUrl && productUrl.startsWith('//')) productUrl = `https:${productUrl}`;
            if (!productUrl) productUrl = `https://www.aliexpress.com/item/${productId}.html`;

            products.push({
                product_id: productId,
                title,
                price,
                original_price: originalPrice,
                currency: 'USD',
                rating,
                reviews_count: reviewsCount,
                orders,
                store_name: storeName,
                store_url: storeUrl,
                image_url: imageUrl,
                product_url: productUrl,
            });
        }

        log.info(`Extracted ${products.length} products from JSON`);
    } catch (err) {
        log.error(`JSON extraction error: ${err.message}`);
    }

    return products;
};

// Extract JSON-LD data
const extractFromJsonLd = (htmlContent) => {
    const products = [];
    try {
        const jsonLdMatches = htmlContent.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
        for (const match of jsonLdMatches) {
            try {
                const data = JSON.parse(match[1]);
                if (data['@type'] === 'Product' || data['@type'] === 'ItemList') {
                    const items = data.itemListElement || [data];
                    for (const item of items) {
                        const prod = item.item || item;
                        if (prod.productID || prod.sku) {
                            products.push({
                                product_id: prod.productID || prod.sku,
                                title: prod.name,
                                price: prod.offers?.price || prod.offers?.lowPrice,
                                original_price: null,
                                currency: prod.offers?.priceCurrency || 'USD',
                                rating: prod.aggregateRating?.ratingValue || null,
                                reviews_count: prod.aggregateRating?.reviewCount || null,
                                orders: null,
                                store_name: prod.brand?.name || null,
                                store_url: null,
                                image_url: normalizeImageUrl(prod.image),
                                product_url: prod.url,
                            });
                        }
                    }
                }
            } catch (e) { /* Skip invalid JSON-LD */ }
        }
    } catch (err) {
        log.debug(`JSON-LD extraction failed: ${err.message}`);
    }
    return products;
};

// Create proxy configuration
const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig || {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
});

let saved = 0;
const seenIds = new Set();
const initial = startUrl ? [{ url: startUrl, userData: { pageNo: 1 } }] : [{ url: buildSearchUrl(keyword, 1), userData: { pageNo: 1 } }];

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestRetries: 5,
    useSessionPool: true,
    sessionPoolOptions: {
        maxPoolSize: 5,
        sessionOptions: { maxUsageCount: 3 },
    },
    maxConcurrency: 2, // Lower concurrency for cost
    requestHandlerTimeoutSecs: 90,
    navigationTimeoutSecs: 45,
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
            // Block heavy resources to reduce cost
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                const url = route.request().url();

                // Block images, fonts, media, and tracking
                if (['image', 'font', 'media', 'stylesheet'].includes(type) ||
                    url.includes('google') || url.includes('facebook') ||
                    url.includes('analytics') || url.includes('doubleclick') ||
                    url.includes('.png') || url.includes('.jpg') || url.includes('.gif')) {
                    return route.abort();
                }
                return route.continue();
            });

            // Stealth overrides
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });
        },
    ],
    async requestHandler({ page, request, crawler: crawlerInstance }) {
        const pageNo = request.userData?.pageNo || 1;
        log.info(`Processing page ${pageNo}: ${request.url}`);

        // Wait for network to settle (minimal wait)
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(3000);

        // Get page content for JSON extraction
        const htmlContent = await page.content();
        log.info(`Page loaded: ${htmlContent.length} bytes`);

        // Check for blocking
        if (htmlContent.length < 10000 || htmlContent.includes('captcha') || htmlContent.includes('punish')) {
            log.warning(`Possible blocking detected. HTML length: ${htmlContent.length}`);
            throw new Error('Blocked - will retry with new session');
        }

        let products = [];

        // 1. Try window._dida_config_ (AliExpress primary data source)
        const didaMatch = htmlContent.match(/window\._dida_config_\s*=\s*(\{[\s\S]*?\});/);
        if (didaMatch) {
            try {
                const jsonData = JSON.parse(didaMatch[1]);
                log.info('Found _dida_config_ data');
                products = extractProductsFromJson(jsonData);
            } catch (e) {
                log.warning(`Failed to parse _dida_config_: ${e.message}`);
            }
        }

        // 2. Try window.runParams
        if (products.length === 0) {
            const runParamsMatch = htmlContent.match(/window\.runParams\s*=\s*(\{[\s\S]*?\});/);
            if (runParamsMatch) {
                try {
                    const jsonData = JSON.parse(runParamsMatch[1]);
                    log.info('Found runParams data');
                    products = extractProductsFromJson(jsonData);
                } catch (e) {
                    log.debug(`Failed to parse runParams: ${e.message}`);
                }
            }
        }

        // 3. Try __NEXT_DATA__
        if (products.length === 0) {
            const nextDataMatch = htmlContent.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
            if (nextDataMatch) {
                try {
                    const jsonData = JSON.parse(nextDataMatch[1]);
                    log.info('Found __NEXT_DATA__');
                    products = extractProductsFromJson(jsonData);
                } catch (e) {
                    log.debug(`Failed to parse __NEXT_DATA__: ${e.message}`);
                }
            }
        }

        // 4. Try __INITIAL_STATE__
        if (products.length === 0) {
            const initialStateMatch = htmlContent.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/);
            if (initialStateMatch) {
                try {
                    const jsonData = JSON.parse(initialStateMatch[1]);
                    log.info('Found __INITIAL_STATE__');
                    products = extractProductsFromJson(jsonData);
                } catch (e) {
                    log.debug(`Failed to parse __INITIAL_STATE__: ${e.message}`);
                }
            }
        }

        // 5. Try JSON-LD
        if (products.length === 0) {
            products = extractFromJsonLd(htmlContent);
            if (products.length > 0) {
                log.info(`Found ${products.length} products from JSON-LD`);
            }
        }

        // 6. Last resort: Extract from inline script data
        if (products.length === 0) {
            const scriptMatches = htmlContent.matchAll(/"itemList"\s*:\s*(\[[\s\S]*?\])/g);
            for (const match of scriptMatches) {
                try {
                    const items = JSON.parse(match[1]);
                    if (items.length > 0) {
                        log.info(`Found itemList with ${items.length} items`);
                        products = extractProductsFromJson({ itemList: items });
                        break;
                    }
                } catch (e) { /* Skip */ }
            }
        }

        log.info(`Total products found: ${products.length}`);

        // Save products
        const newProducts = [];
        for (const product of products) {
            if (saved >= RESULTS_WANTED) break;

            const id = product.product_id;
            if (id && !seenIds.has(id)) {
                seenIds.add(id);
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
            const nextUrl = buildSearchUrl(keyword, nextPage);
            log.info(`Enqueueing page ${nextPage}...`);
            await crawlerInstance.addRequests([{
                url: nextUrl,
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
