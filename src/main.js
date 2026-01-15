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

// Deep search for product arrays - more aggressive
const findProductArrays = (obj, depth = 0, path = '') => {
    const results = [];
    if (depth > 15 || !obj) return results;

    if (Array.isArray(obj) && obj.length > 0) {
        const firstItem = obj[0];
        // Check for various product indicators
        if (firstItem && typeof firstItem === 'object') {
            const hasProductId = firstItem.productId || firstItem.itemId || firstItem.id;
            const hasTitle = firstItem.title || firstItem.name || firstItem.subject;
            const hasPrice = firstItem.price || firstItem.prices || firstItem.salePrice;

            if (hasProductId || (hasTitle && hasPrice)) {
                results.push({ path, items: obj });
            }
        }
    }

    if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
        for (const key of Object.keys(obj)) {
            const newPath = path ? `${path}.${key}` : key;
            const subResults = findProductArrays(obj[key], depth + 1, newPath);
            results.push(...subResults);
        }
    }

    return results;
};

// Extract products from a single item
const extractProduct = (data) => {
    // Handle nested item structure
    const item = data.item || data;

    const productId = String(
        item.productId || item.itemId || item.id ||
        item.offerId || item.product_id || ''
    );
    if (!productId) return null;

    // Title extraction - handle various structures
    let title = null;
    if (item.title) {
        if (typeof item.title === 'object') {
            title = item.title.displayTitle || item.title.seoTitle || item.title.text;
        } else {
            title = item.title;
        }
    }
    title = title || item.subject || item.productTitle || item.name || null;
    if (!title) return null;

    // Price extraction
    const price = extractPriceValue(
        item.prices?.salePrice || item.salePrice ||
        item.price || item.prices?.minPrice ||
        item.minPrice || item.currentPrice
    );
    const originalPrice = extractPriceValue(
        item.prices?.originalPrice || item.oriPrice ||
        item.originalPrice || item.maxPrice
    );

    // Rating & reviews
    const rating =
        item.evaluation?.starRating || item.starRating ||
        item.averageStar || item.rating ||
        item.averageStarRate || null;
    const reviewsCount =
        item.evaluation?.totalCount || item.reviewCount ||
        item.reviewsCount || item.totalReviews || null;

    // Orders/sold
    const orders = parseSoldCount(
        item.trade?.tradeDesc || item.tradeDesc ||
        item.salesCount || item.soldCount ||
        item.sold || item.orders
    );

    // Store info
    const storeName =
        item.store?.storeName || item.storeName ||
        item.shopName || item.sellerName || null;
    let storeUrl = item.store?.storeUrl || item.storeUrl || null;
    if (storeUrl && storeUrl.startsWith('//')) storeUrl = `https:${storeUrl}`;
    if (!storeUrl && (item.store?.storeId || item.storeId)) {
        storeUrl = `https://www.aliexpress.com/store/${item.store?.storeId || item.storeId}`;
    }

    // Image
    let imageUrl =
        item.image?.imgUrl || item.imageUrl ||
        item.img || item.productImage ||
        item.image || item.picUrl || null;
    if (typeof imageUrl === 'object') imageUrl = imageUrl.imgUrl || null;
    imageUrl = normalizeImageUrl(imageUrl);

    // Product URL
    let productUrl = item.productDetailUrl || item.detailUrl || item.url || null;
    if (productUrl && productUrl.startsWith('//')) productUrl = `https:${productUrl}`;
    if (!productUrl) productUrl = `https://www.aliexpress.com/item/${productId}.html`;

    return {
        product_id: productId,
        title: String(title).trim(),
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
    };
};

// Extract products from JSON data
const extractProductsFromJson = (jsonData, sourceName = 'JSON') => {
    const products = [];

    try {
        // Find all potential product arrays
        const productArrays = findProductArrays(jsonData);

        if (productArrays.length === 0) {
            // Log top-level keys for debugging
            const topKeys = Object.keys(jsonData).slice(0, 20);
            log.info(`${sourceName} top-level keys: ${topKeys.join(', ')}`);
            return [];
        }

        log.info(`Found ${productArrays.length} potential product array(s)`);

        // Use the largest array that yields valid products
        let bestProducts = [];
        for (const { path, items } of productArrays) {
            log.debug(`Trying path: ${path} with ${items.length} items`);

            const extracted = [];
            for (const item of items) {
                const product = extractProduct(item);
                if (product) {
                    extracted.push(product);
                }
            }

            if (extracted.length > bestProducts.length) {
                bestProducts = extracted;
                log.info(`Best path so far: ${path} with ${extracted.length} products`);
            }
        }

        products.push(...bestProducts);
        log.info(`Extracted ${products.length} products from ${sourceName}`);
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
                        if (prod.productID || prod.sku || prod.name) {
                            products.push({
                                product_id: prod.productID || prod.sku || String(Math.random()),
                                title: prod.name,
                                price: prod.offers?.price || prod.offers?.lowPrice,
                                original_price: null,
                                currency: prod.offers?.priceCurrency || 'USD',
                                rating: prod.aggregateRating?.ratingValue || null,
                                reviews_count: prod.aggregateRating?.reviewCount || null,
                                orders: null,
                                store_name: prod.brand?.name || null,
                                store_url: null,
                                image_url: normalizeImageUrl(typeof prod.image === 'string' ? prod.image : prod.image?.[0]),
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
    maxConcurrency: 2,
    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 90,
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
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            });

            await page.route('**/*', (route) => {
                const url = route.request().url();
                if (url.includes('google-analytics') ||
                    url.includes('googletagmanager') ||
                    url.includes('facebook.com') ||
                    url.includes('doubleclick')) {
                    return route.abort();
                }
                return route.continue();
            });

            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });
        },
    ],
    async requestHandler({ page, request, crawler: crawlerInstance }) {
        const pageNo = request.userData?.pageNo || 1;
        log.info(`Processing page ${pageNo}: ${request.url}`);

        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(5000);

        const htmlContent = await page.content();
        log.info(`Page loaded: ${htmlContent.length} bytes`);

        if (htmlContent.length < 5000 ||
            htmlContent.includes('/_____tmd_____/punish') ||
            htmlContent.includes('robot check')) {
            log.warning(`Blocking detected. HTML length: ${htmlContent.length}`);
            throw new Error('Blocked - will retry with new session');
        }

        let products = [];

        // 1. Try window._dida_config_
        const didaMatch = htmlContent.match(/window\._dida_config_\s*=\s*(\{[\s\S]*?\});[\s\n]*(?:window\.|<\/script>)/);
        if (didaMatch) {
            try {
                const jsonData = JSON.parse(didaMatch[1]);
                log.info('Found _dida_config_ data');
                products = extractProductsFromJson(jsonData, '_dida_config_');
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
                    products = extractProductsFromJson(jsonData, 'runParams');
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
                    products = extractProductsFromJson(jsonData, '__NEXT_DATA__');
                } catch (e) {
                    log.debug(`Failed to parse __NEXT_DATA__: ${e.message}`);
                }
            }
        }

        // 4. Try window._data_ or other common patterns
        if (products.length === 0) {
            const patterns = [
                /window\._data_\s*=\s*(\{[\s\S]*?\});/,
                /window\.pageData\s*=\s*(\{[\s\S]*?\});/,
                /window\.__INITIAL_DATA__\s*=\s*(\{[\s\S]*?\});/,
            ];
            for (const pattern of patterns) {
                const match = htmlContent.match(pattern);
                if (match) {
                    try {
                        const jsonData = JSON.parse(match[1]);
                        products = extractProductsFromJson(jsonData, 'alternateSource');
                        if (products.length > 0) break;
                    } catch (e) { /* Skip */ }
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

        // 6. Try to extract from page via evaluate (DOM-based as last resort)
        if (products.length === 0) {
            log.info('Trying DOM extraction as fallback...');
            const domProducts = await page.evaluate(() => {
                const products = [];

                // Try to access window data directly
                const w = window;
                const sources = [
                    w._dida_config_,
                    w.runParams,
                    w._data_,
                    w.pageData,
                ];

                for (const source of sources) {
                    if (!source) continue;

                    // Stringify and search
                    try {
                        const str = JSON.stringify(source);
                        if (str.includes('productId') || str.includes('itemId')) {
                            return { raw: source, type: 'windowData' };
                        }
                    } catch (e) { /* Skip */ }
                }

                // Fallback: extract from visible cards
                const cards = document.querySelectorAll('[class*="card-item"], [class*="product-card"], [class*="SearchProduct"]');
                cards.forEach(card => {
                    try {
                        const link = card.querySelector('a[href*="/item/"]');
                        if (!link) return;

                        const href = link.href;
                        const idMatch = href.match(/\/item\/(\d+)\.html/);
                        if (!idMatch) return;

                        const title = card.querySelector('[class*="title"], h3, h2')?.textContent?.trim();
                        const price = card.querySelector('[class*="price"]')?.textContent?.trim();
                        const img = card.querySelector('img')?.src;

                        if (title) {
                            products.push({
                                product_id: idMatch[1],
                                title,
                                price,
                                image_url: img,
                                product_url: href,
                            });
                        }
                    } catch (e) { /* Skip card */ }
                });

                return { products, type: 'dom' };
            });

            if (domProducts.type === 'windowData' && domProducts.raw) {
                log.info('Got window data via evaluate, extracting...');
                products = extractProductsFromJson(domProducts.raw, 'windowEval');
            } else if (domProducts.products?.length > 0) {
                log.info(`Extracted ${domProducts.products.length} products from DOM`);
                products = domProducts.products.map(p => ({
                    ...p,
                    original_price: null,
                    currency: 'USD',
                    rating: null,
                    reviews_count: null,
                    orders: null,
                    store_name: null,
                    store_url: null,
                }));
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
